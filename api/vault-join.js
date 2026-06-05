// POST /api/vault-join?code=<code>  → { vault }
//
// Looks up the invite code across every vault config (linear scan since we
// have no global invite index). For typical instance sizes the cost is
// fine — a few API calls per join. Updates the invite's uses counter and
// adds the caller to the vault's members list, all in one atomic commit.

const gh = require("./_github.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    const user = await auth.requireAuth(req);
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const code = url.searchParams.get("code");
    if (!code) return gh.sendJson(res, 400, { error: "code-Param fehlt" });

    const idx = await gh.readVaultsIndex();
    if (!idx) return gh.sendJson(res, 404, { error: "Vault system not initialized" });

    // Find the vault whose config contains this code
    let foundVault = null;
    let foundConfig = null;
    let foundInvite = null;
    for (const v of (idx.vaults || [])) {
      const cfg = await gh.readVaultConfig(v.id);
      if (!cfg || !Array.isArray(cfg.invites)) continue;
      const inv = cfg.invites.find(i => i.code === code);
      if (inv) { foundVault = v; foundConfig = cfg; foundInvite = inv; break; }
    }
    if (!foundVault) return gh.sendJson(res, 404, { error: "Invite-Code ungültig oder abgelaufen" });

    // Validate
    if (new Date(foundInvite.expiresAt) <= new Date()) {
      return gh.sendJson(res, 410, { error: "Invite-Code ist abgelaufen" });
    }
    if (foundInvite.maxUses && foundInvite.uses >= foundInvite.maxUses) {
      return gh.sendJson(res, 410, { error: "Invite-Code wurde bereits maximal oft verwendet" });
    }
    if (foundVault.members.includes(user.id)) {
      // Idempotent — already a member, just bump uses and return ok
      return gh.sendJson(res, 200, { vault: foundVault, alreadyMember: true });
    }

    // Mutate
    foundInvite.uses = (foundInvite.uses || 0) + 1;
    foundVault.members.push(user.id);

    // Atomic commit: index + config
    const refSha = await gh.getRefSha();
    const baseCommit = await gh.getCommit(refSha);
    const idxBlob = await gh.createBlob(gh.utf8ToB64(gh.buildVaultsIndex(idx)));
    const cfgBlob = await gh.createBlob(gh.utf8ToB64(gh.buildVaultConfig(foundConfig)));
    const tree = await gh.createTree(baseCommit.tree.sha, [
      { path: gh.VAULTS_INDEX_FILE, mode: "100644", type: "blob", sha: idxBlob.sha },
      { path: gh.vaultConfigPath(foundVault.id), mode: "100644", type: "blob", sha: cfgBlob.sha }
    ]);
    await auth.loadUserContext(user);
    const author = (user.github && user.github.commitEmail)
      ? { name: user.github.login || user.username, email: user.github.commitEmail }
      : null;
    const commit = await gh.createCommit(
      `[${user.username}] ${foundVault.name}: per Invite beigetreten`,
      tree.sha, refSha, author
    );
    await gh.updateRef(commit.sha);

    return gh.sendJson(res, 200, { vault: foundVault });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
