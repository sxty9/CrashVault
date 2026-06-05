// POST /api/auth/password
// Body: { currentPassword, newPassword } → { token, user }
//
// Validates `currentPassword` with bcrypt, hashes `newPassword` (cost 12),
// bumps tokenVersion (invalidates all other sessions), commits, and returns
// a fresh JWT so the caller's current device stays logged in.

const bcrypt = require("bcryptjs");
const gh = require("../_github.js");
const auth = require("../_auth.js");

const BCRYPT_COST = 12;

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    const me = await auth.requireAuth(req);
    const { currentPassword, newPassword } = await gh.readJson(req);
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return gh.sendJson(res, 400, { error: "currentPassword + newPassword required" });
    }
    if (newPassword.length < 8 || newPassword.length > 200) {
      return gh.sendJson(res, 400, { error: "Neues Passwort muss 8-200 Zeichen lang sein" });
    }

    const state = await gh.readAccounts();
    const account = (state.accounts || []).find(a => a.id === me.id);
    if (!account) return gh.sendJson(res, 404, { error: "Account nicht gefunden" });

    const ok = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!ok) return gh.sendJson(res, 401, { error: "Aktuelles Passwort falsch" });

    account.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    account.tokenVersion = (account.tokenVersion || 0) + 1;

    await gh.writeAccounts(state, `[${account.username}] Passwort geändert`);

    const token = auth.signSession(account);
    return gh.sendJson(res, 200, { token, user: auth.publicUser(account) });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
