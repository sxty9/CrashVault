// POST /api/auth/login
// Body: { username, password }
// Response: { token, user }
//
// Brute-force defense: in-memory per-IP failure counter with exponential
// backoff (capped at 5s). The counter resets on success and after 5 minutes
// of inactivity. This is a honeypot, not banking-grade — it survives within
// a single lambda instance only. Sufficient for the threat model.

const bcrypt = require("bcryptjs");
const gh = require("../_github.js");
const auth = require("../_auth.js");

// Per-lambda failure counters
const failures = new Map(); // ip → { count, last }
const FAIL_TTL_MS = 5 * 60 * 1000;

function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function readFailure(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.last > FAIL_TTL_MS) { failures.delete(ip); return 0; }
  return f.count;
}
function bumpFailure(ip) {
  const f = failures.get(ip) || { count: 0, last: 0 };
  f.count += 1; f.last = Date.now();
  failures.set(ip, f);
  return f.count;
}
function clearFailure(ip) { failures.delete(ip); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }

    const ip = clientIp(req);
    const fails = readFailure(ip);
    if (fails > 0) {
      // Exponential backoff capped at 5s — slows down dictionary attacks
      // without making legit retries unbearable.
      const delay = Math.min(Math.pow(2, fails) * 100, 5000);
      await sleep(delay);
    }

    const { username, password } = await gh.readJson(req);
    if (typeof username !== "string" || typeof password !== "string") {
      bumpFailure(ip);
      return gh.sendJson(res, 400, { error: "username + password required" });
    }

    const state = await gh.readAccounts();
    if (!state || !(state.accounts || []).length) {
      // No accounts exist yet — surface a distinct status so the client
      // can route the user to the bootstrap-signup tab instead of "login failed".
      return gh.sendJson(res, 410, { error: "Noch keine Accounts angelegt", needsBootstrap: true });
    }

    const account = state.accounts.find(a => a.username === username);
    // Always run bcrypt.compare even when the account is missing to keep
    // timing roughly constant (bcryptjs handles invalid hashes gracefully).
    const ok = account
      ? await bcrypt.compare(password, account.passwordHash)
      : await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidiu");

    if (!account || !ok) {
      bumpFailure(ip);
      return gh.sendJson(res, 401, { error: "Username oder Passwort falsch" });
    }

    clearFailure(ip);
    const token = auth.signSession(account);
    return gh.sendJson(res, 200, { token, user: auth.publicUser(account) });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
