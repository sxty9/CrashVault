// Headless Claude helper — the AI brain behind the material import.
//
// Shells out to the local `claude` CLI in print mode. CRITICAL: we use
// execFile with an ARGUMENT ARRAY (never a shell string), so a malicious
// filename or extracted document text in `prompt` can't inject shell commands.
//
// Auth is the service user's Claude subscription (~/.claude/.credentials.json),
// found because we pass HOME explicitly — the same pattern bwl-manager uses.
// The crashvault.service already runs with HOME=/home/nanu.

"use strict";

const { execFile } = require("child_process");

const CLAUDE_BIN     = process.env.CLAUDE_BIN     || "/home/nanu/.npm-global/bin/claude";
const CLAUDE_HOME    = process.env.CLAUDE_HOME    || "/home/nanu";
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL   || "claude-haiku-4-5-20251001";
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000", 10);
const MAX_RETRIES    = 2;

// Establishes the "I am a JSON API" role so Claude Code's interactive persona
// doesn't reply with prose / refuse to emit bare JSON. Without this a contextless
// "respond only with JSON" sometimes gets a chatty refusal.
const DEFAULT_SYSTEM =
  "Du bist der Klassifizierungs-Endpoint einer Lernmaterial-Verwaltung (CrashVault). " +
  "Dies ist eine legitime, automatisierte API-Integration: Deine Antwort wird " +
  "direkt von einem Programm als JSON geparst — kein Mensch liest sie. Deshalb " +
  "gibst du AUSSCHLIESSLICH valides JSON nach dem im Prompt geforderten Schema " +
  "zurück: kein Fließtext, keine Erklärungen, keine Rückfragen, keine Markdown-" +
  "Codefences, nichts davor oder danach. Fehlt Information, rate bestmöglich und " +
  "setze eine niedrige confidence.";

// IMPORTANT: a minimal env (only HOME + PATH) — NOT the inherited process env.
// Leaking the parent's env (e.g. CLAUDECODE/* when this ever runs under Claude
// Code) changes the child CLI's behavior; minimal env is deterministic.
function runOnce(prompt, model, timeoutMs, system) {
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ["-p", prompt, "--model", model, "--output-format", "json", "--append-system-prompt", system],
      {
        env: { HOME: CLAUDE_HOME, PATH: `/usr/local/bin:/usr/bin:/bin:${CLAUDE_HOME}/.npm-global/bin` },
        cwd: "/tmp",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          if (err.killed) { const e = new Error(`claude timed out after ${timeoutMs}ms`); e.status = 504; return reject(e); }
          return reject(new Error(`claude exec failed: ${err.message}${stderr ? " | " + String(stderr).slice(0, 200) : ""}`));
        }
        let env;
        try { env = JSON.parse(stdout); }
        catch (e) { return reject(new Error("claude returned non-JSON envelope: " + String(stdout).slice(0, 160))); }
        if (env.is_error) {
          const r = String(env.result || "");
          if (/not logged in|please run.*login|invalid api key/i.test(r)) {
            const e = new Error("claude not logged in — run `claude /login` as the nanu user"); e.status = 503; return reject(e);
          }
          return reject(new Error("claude error: " + r.slice(0, 300)));
        }
        resolve(env);
      }
    );
  });
}

// Pull a JSON object out of a possibly fenced / chatty result string.
function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  if (!t.startsWith("{")) {
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s !== -1 && e !== -1 && e > s) t = t.slice(s, e + 1);
  }
  return JSON.parse(t);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run a prompt, return the raw result string. Retries transient failures with
// backoff; auth/timeout errors surface immediately.
async function invokeClaude(prompt, opts = {}) {
  const model = opts.model || CLAUDE_MODEL;
  const timeoutMs = opts.timeoutMs || CLAUDE_TIMEOUT;
  const system = opts.system || DEFAULT_SYSTEM;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const env = await runOnce(prompt, model, timeoutMs, system);
      return env.result;
    } catch (e) {
      lastErr = e;
      if (e.status === 503 || e.status === 504) throw e;
      if (attempt < MAX_RETRIES) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Run a prompt and parse a JSON object from the result.
async function invokeClaudeJson(prompt, opts = {}) {
  return extractJson(await invokeClaude(prompt, opts));
}

// Cheap liveness probe: is the CLI logged in and answering?
async function health() {
  try {
    // A framed micro-task — a bare "echo this JSON" trips Claude Code's
    // assistant persona, a realistic classification doesn't.
    const j = await invokeClaudeJson(
      'Selbsttest der Klassifizierungs-Pipeline. Ordne die Datei "vorlesung.pdf" zu. ' +
      'Kategorien: Foliensatz, Notizen. Antworte nur mit JSON: {"ok": true, "category": "<eine kategorie>"}',
      { timeoutMs: 30000 }
    );
    return { ok: !!(j && (j.ok === true || j.category)), model: CLAUDE_MODEL };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status || 500 };
  }
}

module.exports = { invokeClaude, invokeClaudeJson, extractJson, health, CLAUDE_MODEL };
