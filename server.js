// Re+Active — server
// Serves the chat UI and proxies conversations to Claude or Gemini.
// API keys stay here on the server; the browser never sees them.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

async function askClaude(messages, modeNote) {
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
      system: SYSTEM_PROMPT + modeNote,
      messages: messages.map(m => ({ role: m.role, content: m.text }))
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`);
  return data.content.map(c => c.text || "").join("");
}

async function askGemini(messages, modeNote) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT + modeNote }] },
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
// body: { messages: [{role:'user'|'assistant', text}], provider: 'claude'|'gemini', mode: 'explorer'|'professional' }
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, provider = "claude", mode = "explorer" } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "messages required" });

    const modeNote = `\n\n<app_context>Active mode set by the user in the app: ${
      mode === "professional" ? "PROFESSIONAL MODE (file 09 governs)" : "EXPLORER MODE (default)"
    }. This is an app conversation: keep responses concise.</app_context>`;

    const reply = provider === "gemini"
      ? await askGemini(messages, modeNote)
      : await askClaude(messages, modeNote);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "The conversation service is unavailable right now. Please try again." });
  }
});

// ---------- Crisis directory (editable without redeploying code) ----------
app.get("/api/crisis", (_req, res) => {
  res.sendFile(path.join(__dirname, "crisis-directory.json"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Re+Active running on port ${PORT}`));
