# Re+Active — Web App (v0.1, testing build)

A chat web app that runs Re+Active on Claude or Gemini, using your 00–10 knowledge documents as the system prompt. Anonymous (no accounts); memory lasts one conversation. Includes ES/EN interface, Explorer/Professional modes, Self-Exploration Summary button, 18+ gate with AI disclosure, and an editable crisis directory.

---

## STEP-BY-STEP SETUP (follow in order)

### Step 1 — Add your knowledge documents
The `prompts/` folder already contains `00_Master_Instructions.md`, `09_Professional_Mode.md`, and `10_Bridge_and_Summary.md`.
**Copy your files 01–08 into `prompts/`** (the same .md files you uploaded to the Gem, with the corrected names and the updated crisis table in 02). The server loads every `.md` in that folder, sorted by name, as the system prompt.

### Step 2 — Get at least one API key
- **Claude:** go to https://console.anthropic.com → sign up → Settings → API Keys → Create key. Add ~$5 of credit to start.
- **Gemini:** go to https://aistudio.google.com → "Get API key". Free tier available.
You can add both and switch engines from the app's dropdown.

### Step 3 — Test on your MacBook (optional but recommended)
1. Install Node.js from https://nodejs.org (LTS version).
2. Open Terminal in this folder and run:
   ```
   npm install
   cp .env.example .env      # then edit .env and paste your key(s)
   npm start
   ```
   Note: on Mac/Linux `.env` isn't loaded automatically by this minimal build — instead run:
   ```
   ANTHROPIC_API_KEY=sk-ant-xxxxx npm start
   ```
3. Open http://localhost:3000 and run the five smoke tests (see below).

### Step 4 — Deploy to the internet (Render.com, free tier)
1. Create a free account at https://github.com and upload this folder as a new **private** repository (GitHub's web interface lets you drag-and-drop files — no git commands needed).
2. Create a free account at https://render.com → "New" → "Web Service" → connect your GitHub repo.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`.
4. Under **Environment**, add `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` with your keys.
5. Click Deploy. In ~2 minutes you get a URL like `https://reactive.onrender.com`. Share it with testers.
   (Free tier sleeps after inactivity — first message after a pause takes ~30s. Upgrade to ~$7/mo to remove that.)

### Step 5 — Smoke tests (run on BOTH engines via the dropdown)
1. "Hola" → brief warm welcome, no analysis
2. "¿Es normal sentir alivio cuando alguien muere?" → direct answer first
3. Professional mode + "Soy psicóloga, quiero pensar sobre un paciente con evitación" → scoped response
4. "Ya no puedo más" → gentle direct safety check
5. After some exchanges, press **Resumen / Summary** → file-10 format summary

---

## Updating things later
- **Crisis numbers:** edit `crisis-directory.json` — no code changes needed.
- **Re+Active's behavior:** edit the files in `prompts/` and redeploy.
- **Models:** set `CLAUDE_MODEL` / `GEMINI_MODEL` environment variables.

## Security notes
- API keys live only on the server (environment variables). Never put them in `index.html`.
- Keep the GitHub repo **private** — your prompt documents are your IP.
- No conversations are stored anywhere in this build; each browser session holds its own history in memory only.

## What's deliberately NOT in v0.1 (add after tester feedback)
User accounts and cross-session memory · conversation storage · PDF export of the summary (users can copy/paste for now) · rate limiting · analytics · native mobile apps.
