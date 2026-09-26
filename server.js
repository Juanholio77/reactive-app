// Re+Active — server
// Serves the chat UI and proxies conversations to Claude or Gemini.
// API keys stay here on the server; the browser never sees them.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Firebase Admin (optional auth) ----------
// Login is OPTIONAL: requests without a token are treated as guests.
// Requires env var FIREBASE_SERVICE_ACCOUNT with the JSON of a service
// account key. If the var is missing, auth is disabled and everything
// works as guest — the app never breaks because of this.
let firebaseAuth = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require("firebase-admin");
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
    firebaseAuth = admin.auth();
    console.log("Firebase Admin initialized — token verification enabled");
  } else {
    console.log("FIREBASE_SERVICE_ACCOUNT not set — running in guest-only mode");
  }
} catch (err) {
  console.error("Firebase Admin init failed — running in guest-only mode:", err.message);
}

// Middleware: verify Bearer token if present; never blocks the request.
async function attachUser(req, _res, next) {
  req.user = null;
  const header = req.headers.authorization || "";
  if (firebaseAuth && header.startsWith("Bearer ")) {
    try {
      req.user = await firebaseAuth.verifyIdToken(header.slice(7));
    } catch {
      req.user = null; // invalid/expired token → treat as guest
    }
  }
  next();
}

// ---------- Load the Re+Active knowledge documents ----------
// Every .md file in /prompts is concatenated (sorted by filename: 00, 01, 02...)
// into one system prompt. Drop your canonical 01-08 files into /prompts.
function buildSystemPrompt() {
  const dir = path.join(__dirname, "prompts");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();
  if (files.length === 0) throw new Error("No prompt files found in /prompts");
  return files
    .map(f => `<document name="${f.replace(".md", "")}">\n${fs.readFileSync(path.join(dir, f), "utf8")}\n</document>`)
    .join("\n\n");
}
let SYSTEM_PROMPT = buildSystemPrompt();
console.log(`Loaded system prompt from /prompts (${SYSTEM_PROMPT.length} chars)`);

// ---------- Providers ----------
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Both providers now take an explicit systemPrompt string (rather than
// hardcoding SYSTEM_PROMPT internally) so the same call path can be reused
// for the main companion chat AND the much smaller "what should we
// remember about this user" extraction call below.
async function askClaude(messages, systemPrompt, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.text }))
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`);
  return data.content.map(c => c.text || "").join("");
}

async function askGemini(messages, systemPrompt, maxTokens = 1024) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }]
      })),
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini API error: ${JSON.stringify(data)}`);
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
}

// ---------- Memory: inject what's already known into the companion prompt ----------
function buildMemoryBlock(memory, lang) {
  if (!Array.isArray(memory) || memory.length === 0) return "";
  const list = memory
    .filter(f => typeof f === "string" && f.trim())
    .slice(-40)
    .map(f => `- ${f.trim()}`)
    .join("\n");
  if (!list) return "";
  return lang === "en"
    ? `\n\n<user_memory>What you already know about this user, from past sessions:\n${list}\nUse this naturally, only when it's actually relevant to what they're saying right now. Never recite it back or bring it up mechanically.</user_memory>`
    : `\n\n<user_memory>Lo que ya sabes de este usuario, de sesiones anteriores:\n${list}\nÚsalo con naturalidad, solo cuando de verdad sea relevante para lo que está diciendo ahora. Nunca lo repitas en voz alta ni lo menciones de forma mecánica.</user_memory>`;
}

// ---------- Memory: extraction (background "what should we remember?") ----------
// This is a small, narrowly-scoped side call — separate from the main
// companion persona — whose only job is to look at the latest exchange and
// propose 0-2 short, durable facts worth remembering for next time. The
// client shows each suggestion to the user and only stores what they
// explicitly approve; this endpoint never writes anything itself.
const MEMORY_EXTRACT_PROMPT_ES = `Tu única tarea es revisar el último intercambio de una conversación de acompañamiento emocional y detectar si el usuario reveló algún dato DURADERO que valga la pena recordar en futuras sesiones (preferencias, contexto de vida, temas recurrentes, restricciones que mencionó explícitamente). Esto no es un diagnóstico clínico: no interpretes, no clasifiques, no evalúes.

Reglas estrictas:
- Como máximo 2 datos nuevos, en frases muy cortas y neutrales, en tercera persona ("Trabaja en...", "Prefiere que le hablen directo", "Está atravesando...").
- Nunca inventes ni infieras más allá de lo que el usuario dijo explícitamente en este intercambio.
- Ignora desahogos puntuales, estados de ánimo pasajeros o detalles de un solo momento — solo lo que probablemente siga siendo cierto y útil después.
- Si algo de la lista de "ya sabido" ya cubre el dato, no lo repitas.
- Si no hay nada nuevo que valga la pena, responde con una lista vacía.
- Nunca incluyas datos de identificación (nombres completos, direcciones, teléfonos, documentos, contraseñas) ni datos financieros o de salud sensibles (diagnósticos, medicamentos).

Responde ÚNICAMENTE con JSON válido, exactamente en este formato, sin texto adicional ni bloque de código:
{"facts": ["dato 1", "dato 2"]}
Si no hay nada nuevo: {"facts": []}`;

const MEMORY_EXTRACT_PROMPT_EN = `Your only task is to review the latest exchange of an emotional-companionship conversation and detect whether the user revealed any DURABLE fact worth remembering for future sessions (preferences, life context, recurring themes, constraints they explicitly mentioned). This is not a clinical diagnosis: do not interpret, classify, or evaluate.

Strict rules:
- At most 2 new facts, as very short, neutral, third-person sentences ("Works in...", "Prefers direct communication", "Is going through...").
- Never invent or infer beyond what the user explicitly said in this exchange.
- Ignore one-off venting, passing moods, or single-moment details — only what will likely still be true and useful later.
- If something in the "already known" list already covers it, don't repeat it.
- If there's nothing new worth keeping, respond with an empty list.
- Never include identifying information (full names, addresses, phone numbers, ID numbers, passwords) or sensitive financial/health data (diagnoses, medications).

Respond ONLY with valid JSON, in exactly this format, no extra text and no code fence:
{"facts": ["fact 1", "fact 2"]}
If there's nothing new: {"facts": []}`;

function parseFactsJson(raw) {
  try {
    const cleaned = String(raw || "")
      .trim()
      .replace(/^```(json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.facts)) {
      return parsed.facts
        .filter(f => typeof f === "string" && f.trim())
        .map(f => f.trim())
        .slice(0, 2);
    }
    return [];
  } catch {
    return [];
  }
}

// ---------- Chat endpoint ----------
// body: { messages: [{role,text}], provider: 'claude'|'gemini',
//         mode: 'explorer'|'professional', lang: 'es'|'en', memory: string[] }
// Optional header: Authorization: Bearer <Firebase ID token> → req.user.{uid,email,name}
app.post("/api/chat", attachUser, async (req, res) => {
  const { lang = "es" } = req.body || {};
  try {
    const { messages, provider = "claude", mode = "explorer", memory } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "messages required" });

    // req.user is available here for future per-user features
    // (e.g., saving conversation history keyed by req.user.uid).
    if (req.user) console.log(`Chat request from authenticated user: ${req.user.uid}`);

    const language = lang === "en" ? "English" : "Spanish";
    const contextNote = `\n\n<app_context>Active mode set by the user in the app: ${
      mode === "professional" ? "PROFESSIONAL MODE (file 09 governs)" : "EXPLORER MODE (default)"
    }. The user has selected ${language} as their interface language — reply in ${language} unless they clearly write in another language, in which case follow their lead. This is an app conversation: keep responses concise.</app_context>`;

    const memoryBlock = buildMemoryBlock(memory, lang);
    const fullSystem = SYSTEM_PROMPT + contextNote + memoryBlock;

    const reply = provider === "gemini"
      ? await askGemini(messages, fullSystem)
      : await askClaude(messages, fullSystem);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: lang === "en"
        ? "The conversation service is unavailable right now. Please try again."
        : "El servicio de conversación no está disponible en este momento. Intenta de nuevo."
    });
  }
});

// ---------- Memory suggestion endpoint ----------
// body: { recent: [{role,text}] (the latest user+assistant pair),
//         existing: string[] (facts already stored for this user),
//         provider: 'claude'|'gemini', lang: 'es'|'en' }
// Always responds 200 with { facts: [] } on any failure — this is a
// nice-to-have side feature and must never break or slow down the chat.
app.post("/api/memory/suggest", async (req, res) => {
  try {
    const { recent, existing = [], provider = "claude", lang = "es" } = req.body || {};
    if (!Array.isArray(recent) || recent.length === 0) return res.json({ facts: [] });

    const basePrompt = lang === "en" ? MEMORY_EXTRACT_PROMPT_EN : MEMORY_EXTRACT_PROMPT_ES;
    const knownList = Array.isArray(existing)
      ? existing.filter(f => typeof f === "string" && f.trim()).slice(-40)
      : [];
    const knownBlock = knownList.length
      ? `\n\n${lang === "en" ? "Already known" : "Ya sabido"}:\n${knownList.map(f => `- ${f}`).join("\n")}`
      : "";

    const raw = provider === "gemini"
      ? await askGemini(recent, basePrompt + knownBlock, 220)
      : await askClaude(recent, basePrompt + knownBlock, 220);

    res.json({ facts: parseFactsJson(raw) });
  } catch (err) {
    console.error("memory/suggest failed (non-critical):", err.message);
    res.json({ facts: [] });
  }
});

// ---------- Crisis directory (editable without redeploying code) ----------
app.get("/api/crisis", (_req, res) => {
  res.sendFile(path.join(__dirname, "crisis-directory.json"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Re+Active running on port ${PORT}`));
