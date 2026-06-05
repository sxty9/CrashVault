// POST   /api/vault-members?id=<vid>   body: { username }  → { vault }
// DELETE /api/vault-members?id=<vid>&user=<uid|me>         → { vault }
//
// POST is owner-only. DELETE allows the caller to remove themselves
// (`user=me` or matching uid) regardless of role, except that the owner
// cannot leave without transferring first.

const gh = require("./_github.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");

    if (req.method === "POST") {
      const ctx = await auth.requireVaultOwner(req, vaultId);
      const { username } = await gh.readJson(req);
      if (!gh.validUsername(username)) {
        return gh.sendJson(res, 400, { error: "Username ungültig" });
      }
      const accounts = await gh.readAccounts();
      const target = (accounts?.accounts || []).find(a => a.username === username);
      if (!target) return gh.sendJson(res, 404, { error: "Kein Account mit diesem Username" });

      const vault = ctx.vault;
      if (vault.members.includes(target.id)) {
        return gh.sendJson(res, 409, { error: "Schon Mitglied" });
      }
      vault.members.push(target.id);

      await commitIndex(ctx, `Mitglied hinzugefügt: ${target.username}`);
      return gh.sendJson(res, 200, { vault });
    }

    if (req.method === "DELETE") {
      const targetParam = url.searchParams.get("user");
      // Members can remove themselves. Owners can remove any member but
      // not themselves (must transfer first).
      const ctxMember = await auth.requireVaultMember(req, vaultId);
      const myId = ctxMember.user.id;
      const targetId = (targetParam === "me" || !targetParam) ? myId : targetParam;
      const isSelf = targetId === myId;

      if (!isSelf) {
        // Removing someone else requires owner role
        if (ctxMember.vault.owner !== myId) {
          return gh.sendJson(res, 403, { error: "Nur der Owner darf andere entfernen" });
        }
      } else if (ctxMember.vault.owner === myId) {
        return gh.sendJson(res, 400, { error: "Owner kann nicht austreten — erst Ownership übertragen" });
      }

      const vault = ctxMember.vault;
      if (!vault.members.includes(targetId)) {
        return gh.sendJson(res, 404, { error: "Kein Mitglied" });
      }
      vault.members = vault.members.filter(uid => uid !== targetId);

      await commitIndex(ctxMember, `Mitglied entfernt: ${targetId}`);
      return gh.sendJson(res, 200, { vault });
    }

    res.setHeader("Allow", "POST, DELETE");
    return gh.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return gh.sendError(res, e);
  }
};

async function commitIndex(ctx, summary) {
  const refSha = await gh.getRefSha();
  const baseCommit = await gh.getCommit(refSha);
  const blob = await gh.createBlob(gh.utf8ToB64(gh.buildVaultsIndex(ctx.vaultsIndex)));
  const tree = await gh.createTree(baseCommit.tree.sha, [
    { path: gh.VAULTS_INDEX_FILE, mode: "100644", type: "blob", sha: blob.sha }
  ]);
  await auth.loadUserContext(ctx.user);
  const author = (ctx.user.github && ctx.user.github.commitEmail)
    ? { name: ctx.user.github.login || ctx.user.username, email: ctx.user.github.commitEmail }
    : null;
  const commit = await gh.createCommit(
    `[${ctx.user.username}] ${ctx.vault.name}: ${summary}`,
    tree.sha, refSha, author
  );
  await gh.updateRef(commit.sha);
}
