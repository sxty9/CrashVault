// GET /api/auth/me
// Optional auth — used by the login screen to figure out:
//   200 + { user, config }  → already signed in, route to dashboard
//   401                     → no/invalid token, show login form
//   410 + { needsBootstrap } → no accounts.js yet, show bootstrap tab
//
// The login screen ALSO needs to know whether signup is currently allowed
// (so it can show / hide the Sign Up tab). We return `config.allowSignup`
// alongside the user when present.

const gh = require("../_github.js");
const auth = require("../_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }

    const state = await gh.readAccounts();
    const needsBootstrap = !state || !(state.accounts || []).length;
    const config = (state && state.config) || { allowSignup: false };

    // Bootstrap case takes precedence — even valid sessions are meaningless
    // before any accounts exist (and shouldn't be possible anyway).
    if (needsBootstrap) {
      return gh.sendJson(res, 410, { needsBootstrap: true, config });
    }

    // Try optional auth
    const user = await auth.tryAuth(req);
    if (!user) {
      return gh.sendJson(res, 401, { error: "Not signed in", config });
    }
    return gh.sendJson(res, 200, { user: auth.publicUser(user), config });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
