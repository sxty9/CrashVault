// GET  /api/vaults  → { vaults: [...] }   (only vaults this user is a member of)
// POST /api/vaults  body: { name, color? } → { vault }
//
// Lists vaults from the access-control index. If no vaults/index.js exists
// yet, the GET path silently triggers the bootstrap migration so the user
// always sees their auto-created default vault.

const gh = require("./_github.js");
const auth = require("./_auth.js");

function uid() {
  return "v_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

module.exports = async (req, res) => {
  try {
    const user = await auth.requireAuth(req);

    if (req.method === "GET") {
      let idx = await gh.readVaultsIndex();
      if (!idx) {
        // First request after Phase 2 deploy — migrate now.
        idx = await gh.ensureVaultsMigration(user);
      }
      const mine = (idx.vaults || []).filter(v => (v.members || []).includes(user.id));
      return gh.sendJson(res, 200, { vaults: mine });
    }

    if (req.method === "POST") {
      const { name, color } = await gh.readJson(req);
      if (typeof name !== "string" || !name.trim() || name.length > 80) {
        return gh.sendJson(res, 400, { error: "Vault-Name fehlt oder zu lang" });
      }

      // Ensure migration ran before adding a fresh vault — otherwise the
      // first user's BWL data would stay orphaned at modules/*.
      let idx = await gh.readVaultsIndex();
      if (!idx) idx = await gh.ensureVaultsMigration(user);

      const vault = {
        id: uid(),
        name: name.trim(),
        color: (color && /^#[0-9a-f]{6}$/i.test(color)) ? color : "#38bdf8",
        owner: user.id,
        members: [user.id],
        createdAt: new Date().toISOString()
      };
      idx.vaults.push(vault);

      const config = { id: vault.id, name: vault.name, description: "", invites: [] };

      // Atomic commit: index + config in one tree
      const refSha = await gh.getRefSha();
      const baseCommit = await gh.getCommit(refSha);
      const indexBlob  = await gh.createBlob(gh.utf8ToB64(gh.buildVaultsIndex(idx)));
      const configBlob = await gh.createBlob(gh.utf8ToB64(gh.buildVaultConfig(config)));
      const treeResult = await gh.createTree(baseCommit.tree.sha, [
        { path: gh.VAULTS_INDEX_FILE, mode: "100644", type: "blob", sha: indexBlob.sha },
        { path: gh.vaultConfigPath(vault.id), mode: "100644", type: "blob", sha: configBlob.sha }
      ]);
      await auth.loadUserContext(user);
      const author = (user.github && user.github.commitEmail)
        ? { name: user.github.login || user.username, email: user.github.commitEmail }
        : null;
      const commit = await gh.createCommit(
        `[${user.username}] Vault angelegt: ${vault.name}`,
        treeResult.sha, refSha, author
      );
      await gh.updateRef(commit.sha);

      return gh.sendJson(res, 200, { vault });
    }

    res.setHeader("Allow", "GET, POST");
    return gh.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
