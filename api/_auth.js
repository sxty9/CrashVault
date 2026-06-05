// Auth middleware: JWT issue + verify, requireAuth gate.
//
// Tokens are HMAC-SHA256 signed with process.env.JWT_SECRET. Each payload
// carries the user's id, username, role, and the user's current tokenVersion;
// a mismatch between the JWT's `tv` and the user's accounts.js `tokenVersion`
// invalidates the session (used for "logout everywhere" and password change).

const jwt = require("jsonwebtoken");
const gh = require("./_github.js");

const SESSION_TTL = "7d";

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    const e = new Error("JWT_SECRET env variable missing or too short (need 32+ chars)");
    e.status = 500; throw e;
  }
  return s;
}

// Sign a fresh session token for a user. Keep the payload small — what the
// client needs to remember is just enough to re-identify itself.
function signSession(user) {
  return jwt.sign(
    {
      uid: user.id,
      u: user.username,
      r: user.role,
      tv: user.tokenVersion || 0
    },
    getSecret(),
    { algorithm: "HS256", expiresIn: SESSION_TTL }
  );
}

// Verify a Bearer token. Returns the decoded payload or throws an error with
// status:401 attached.
function verifySession(token) {
  try {
    return jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
  } catch (e) {
    const err = new Error("Invalid session: " + e.message);
    err.status = 401;
    throw err;
  }
}

// Extract the bearer token from the request — returns null if missing/wrong
// scheme. Token verification is left to the caller (so optional-auth code
// paths like /api/auth/me can distinguish "no session" from "bad session").
function bearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Hard gate: require a valid session AND a still-existing matching account.
// Returns the resolved account record (with passwordHash redacted) or
// throws — caller wraps in try/catch and lets `sendError` translate.
async function requireAuth(req) {
  const token = bearerToken(req);
  if (!token) { const e = new Error("Authentication required"); e.status = 401; throw e; }
  const payload = verifySession(token);
  const state = await gh.readAccounts();
  if (!state) { const e = new Error("Server has no accounts yet"); e.status = 401; throw e; }
  const account = (state.accounts || []).find(a => a.id === payload.uid);
  if (!account) { const e = new Error("Account no longer exists"); e.status = 401; throw e; }
  if ((account.tokenVersion || 0) !== payload.tv) {
    const e = new Error("Session was invalidated — please sign in again"); e.status = 401; throw e;
  }
  // Never leak passwordHash even to authenticated callers
  const { passwordHash, ...safe } = account;
  return safe;
}

// Soft auth — returns the resolved user if a valid token was supplied, else
// null. Used for /api/auth/me where 401 vs "anonymous" matters at the UX layer.
async function tryAuth(req) {
  try { return await requireAuth(req); }
  catch (e) { return null; }
}

// Public-facing projection of an account — what the client sees in
// /auth/me or /auth/login responses. Strips password + tokenVersion.
function publicUser(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    createdAt: account.createdAt,
    github: account.github || null
  };
}

module.exports = {
  SESSION_TTL,
  signSession, verifySession, bearerToken,
  requireAuth, tryAuth, publicUser
};
