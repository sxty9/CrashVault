// POST /api/vault-transfer?id=<vid>  body: { toUsername }  → { vault }
//
// Owner-only. Transfers ownership to another existing member. The target
// must already be a member; if you want to invite + transfer in one step,
// add them via /api/vault-members first.

const gh = require("./_github.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");
    const ctx = await auth.requireVaultOwner(req, vaultId);

    const { toUsername } = await gh.readJson(req);
    if (!gh.validUsername(toUsername)) {
      return gh.sendJson(res, 400, { error: "Username ungültig" });
    }
    const accounts = await gh.readAccounts();
    const target = (accounts?.accounts || []).find(a => a.username === toUsername);
    if (!target) return gh.sendJson(res, 404, { error: "Kein Account mit diesem Username" });
    if (!ctx.vault.members.includes(target.id)) {
      return gh.sendJson(res, 400, { error: "Empfänger ist noch kein Mitglied — erst hinzufügen" });
    }
    if (target.id === ctx.user.id) {
      return gh.sendJson(res, 400, { error: "Du bist schon Owner" });
    }

    ctx.vault.owner = target.id;

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
      `[${ctx.user.username}] ${ctx.vault.name}: Ownership an ${target.username} übertragen`,
      tree.sha, refSha, author
    );
    await gh.updateRef(commit.sha);

    return gh.sendJson(res, 200, { vault: ctx.vault });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
