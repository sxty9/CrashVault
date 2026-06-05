// GET  /api/settings  → { settings }
// POST /api/settings  body: { settings } → { ok }
//
// Per-user settings file: features, tile layouts (account-default),
// preferences, github-link. The full object replaces server state on POST
// (client owns the merge); server validates basic shape only.

const gh = require("./_github.js");
const auth = require("./_auth.js");

function sanitize(settings) {
  // Whitelist top-level keys so a tampered client can't smuggle in extra
  // fields. github is allowed but treated as read-only here — write goes
  // through /api/github/link to ensure a fresh fetch from GitHub.
  const out = {
    features: (settings && typeof settings.features === "object") ? settings.features : {},
    tileLayouts: (settings && typeof settings.tileLayouts === "object") ? settings.tileLayouts : {},
    preferences: (settings && typeof settings.preferences === "object") ? settings.preferences : {}
  };
  return out;
}

module.exports = async (req, res) => {
  try {
    const user = await auth.requireAuth(req);

    if (req.method === "GET") {
      const settings = await gh.readUserSettings(user.id);
      return gh.sendJson(res, 200, { settings });
    }

    if (req.method === "POST") {
      const { settings } = await gh.readJson(req);
      const clean = sanitize(settings);

      // Preserve github linkage from existing settings — /api/github/link is
      // the only path that writes it.
      const existing = await gh.readUserSettings(user.id);
      clean.github = existing.github || null;

      await auth.loadUserContext(user);
      const author = (user.github && user.github.commitEmail)
        ? { name: user.github.login || user.username, email: user.github.commitEmail }
        : null;
      await gh.writeUserSettings(
        user.id, clean,
        `[${user.username}] settings updated`,
        author
      );
      return gh.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return gh.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
