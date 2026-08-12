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

async function askClaude(messages, contextNote) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT + contextNote,
      messages: messages.map(m => ({ role: m.role, content: m.text }))
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`);
  return data.content.map(c => c.text || "").join("");
}

async function askGemini(messages, contextNote) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT + contextNote }] },
      contents: messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }]
      })),
      generationConfig: { maxOutputTokens: 1024 }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini API error: ${JSON.stringify(data)}`);
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
}

// ---------- Chat endpoint ----------
// body: { messages: [{role,text}], provider: 'claude'|'gemini',
//         mode: 'explorer'|'professional', lang: 'es'|'en' }
// Optional header: Authorization: Bearer <Firebase ID token> → req.user.{uid,email,name}
app.post("/api/chat", attachUser, async (req, res) => {
  try {
    const { messages, provider = "claude", mode = "explorer", lang = "es" } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "messages required" });

    // req.user is available here for future per-user features
    // (e.g., saving conversation history keyed by req.user.uid).
    if (req.user) console.log(`Chat request from authenticated user: ${req.user.uid}`);

    const language = lang === "en" ? "English" : "Spanish";
    const contextNote = `\n\n<app_context>Active mode set by the user in the app: ${
      mode === "professional" ? "PROFESSIONAL MODE (file 09 governs)" : "EXPLORER MODE (default)"
    }. The user has selected ${language} as their interface language — reply in ${language} unless they clearly write in another language, in which case follow their lead. This is an app conversation: keep responses concise.</app_context>`;

    const reply = provider === "gemini"
      ? await askGemini(messages, contextNote)
      : await askClaude(messages, contextNote);

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

// ---------- Crisis directory (editable without redeploying code) ----------
app.get("/api/crisis", (_req, res) => {
  res.sendFile(path.join(__dirname, "crisis-directory.json"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Re+Active running on port ${PORT}`));
