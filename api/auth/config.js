// POST /api/auth/config
// Body: { allowSignup }  → { config }
//
// Admin-only. Toggles the global `config.allowSignup` flag in accounts.js.

const gh = require("../_github.js");
const auth = require("../_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    const admin = await auth.requireAdmin(req);
    const { allowSignup } = await gh.readJson(req);
    if (typeof allowSignup !== "boolean") {
      return gh.sendJson(res, 400, { error: "allowSignup boolean required" });
    }
    const state = await gh.readAccounts();
    state.config = state.config || {};
    state.config.allowSignup = allowSignup;
    await gh.writeAccounts(state, `[${admin.username}] allowSignup = ${allowSignup}`);
    return gh.sendJson(res, 200, { config: state.config });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
