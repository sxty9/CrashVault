// POST /api/auth/signup
// Body: { username, password, displayName? }
// Response: { token, user }
//
// Two gates:
//  1. Bootstrap: if accounts.js doesn't exist OR contains zero accounts,
//     anyone may sign up — and the first user is automatically the admin.
//  2. Otherwise: requires `config.allowSignup` to be true (admin-toggled).

const bcrypt = require("bcryptjs");
const gh = require("../_github.js");
const auth = require("../_auth.js");

const BCRYPT_COST = 12;

function uid() {
  // 10-char base36; collision-unlikely for accounts.
  return "u_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }

    const { username, password, displayName } = await gh.readJson(req);

    // Input validation — early bail on obvious garbage
    if (!gh.validUsername(username)) {
      return gh.sendJson(res, 400, { error: "Username muss 2-33 Zeichen [a-z0-9_-] sein und mit Buchstabe/Zahl beginnen" });
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 200) {
      return gh.sendJson(res, 400, { error: "Passwort muss 8-200 Zeichen lang sein" });
    }
    if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 60)) {
      return gh.sendJson(res, 400, { error: "Anzeigename darf max. 60 Zeichen lang sein" });
    }

    // Load current registry — null means file doesn't exist (bootstrap path)
    let state = await gh.readAccounts();
    const bootstrap = !state || !(state.accounts || []).length;

    if (state) {
      const taken = (state.accounts || []).some(a => a.username === username);
      if (taken) return gh.sendJson(res, 409, { error: "Username bereits vergeben" });
      if (!bootstrap && !(state.config && state.config.allowSignup)) {
        return gh.sendJson(res, 403, { error: "Signup ist aktuell deaktiviert. Frag den Admin." });
      }
    } else {
      state = JSON.parse(JSON.stringify(gh.ACCOUNTS_DEFAULT));
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const now = new Date().toISOString();
    const account = {
      id: uid(),
      username,
      displayName: (displayName && displayName.trim()) || username,
      passwordHash,
      role: bootstrap ? "admin" : "user",
      tokenVersion: 1,
      createdAt: now
    };
    state.accounts = state.accounts || [];
    state.accounts.push(account);

    await gh.writeAccounts(
      state,
      bootstrap ? `[bootstrap] ${username} angelegt (admin)` : `[signup] ${username} angelegt`
    );

    const token = auth.signSession(account);
    return gh.sendJson(res, 200, { token, user: auth.publicUser(account) });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
