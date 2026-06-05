// POST   /api/github/link  body: { username } → { github }
// DELETE /api/github/link                       → { ok }
//
// Light GitHub linkage. Server fetches the public github.com /users/<login>
// endpoint to get the canonical `login`, `id`, and `avatar_url`, then
// persists those plus a deterministic commit-email into users/<uid>/settings.js.
// Commits made afterward will be attributed to that identity on GitHub.
//
// We use the central Vercel GITHUB_TOKEN to make the API call so we get the
// authenticated rate limit (5000/h) instead of the public 60/h.

const gh = require("../_github.js");
const auth = require("../_auth.js");

async function fetchGithubUser(login) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "crashvault-app"
    }
  });
  if (res.status === 404) { const e = new Error("GitHub-User existiert nicht"); e.status = 404; throw e; }
  if (!res.ok) { const e = new Error(`GitHub API ${res.status}`); e.status = 502; throw e; }
  return res.json();
}

module.exports = async (req, res) => {
  try {
    const user = await auth.requireAuth(req);

    if (req.method === "POST") {
      const { username } = await gh.readJson(req);
      if (typeof username !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(username)) {
        return gh.sendJson(res, 400, { error: "GitHub-Username ungültig" });
      }
      const profile = await fetchGithubUser(username);
      const linkage = {
        login: profile.login,
        userId: profile.id,
        avatarUrl: profile.avatar_url,
        commitEmail: `${profile.id}+${profile.login}@users.noreply.github.com`,
        linkedAt: new Date().toISOString()
      };

      const settings = await gh.readUserSettings(user.id);
      settings.github = linkage;
      await gh.writeUserSettings(
        user.id, settings,
        `[${user.username}] GitHub-Linkage: @${profile.login}`
      );
      return gh.sendJson(res, 200, { github: linkage });
    }

    if (req.method === "DELETE") {
      const settings = await gh.readUserSettings(user.id);
      if (!settings.github) return gh.sendJson(res, 200, { ok: true });
      settings.github = null;
      await gh.writeUserSettings(
        user.id, settings,
        `[${user.username}] GitHub-Linkage entfernt`
      );
      return gh.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "POST, DELETE");
    return gh.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
