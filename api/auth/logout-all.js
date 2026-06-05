// POST /api/auth/logout-all
// Auth required. Bumps the caller's tokenVersion so every existing JWT (on
// every device) becomes invalid on the next request. The client should then
// drop its local session and re-route to the login screen.

const gh = require("../_github.js");
const auth = require("../_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }

    const me = await auth.requireAuth(req);
    const state = await gh.readAccounts();
    const account = state.accounts.find(a => a.id === me.id);
    if (!account) {
      return gh.sendJson(res, 404, { error: "Account not found" });
    }
    account.tokenVersion = (account.tokenVersion || 0) + 1;

    await gh.writeAccounts(
      state,
      `[logout-all] ${account.username} tokenVersion bumped`
    );

    return gh.sendJson(res, 200, { ok: true, tokenVersion: account.tokenVersion });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
