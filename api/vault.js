// GET    /api/vault?id=<vid>   → { vault, config, accounts? }
// POST   /api/vault?id=<vid>   body: { name?, color?, description? } → { vault }
// DELETE /api/vault?id=<vid>   → { ok: true }   (owner-only, blasts every file)
//
// GET returns BOTH the index entry (members) AND the per-vault config.
// Invite codes are stripped from `config.invites` for non-owners.
// Member usernames are resolved against accounts.js so the UI can display
// "added by @henry" without an extra round-trip.

const gh = require("./_github.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");

    if (req.method === "GET") {
      const ctx = await auth.requireVaultMember(req, vaultId);
      const config = await gh.readVaultConfig(vaultId);
      if (!config) {
        // Index has the vault but config is missing — shouldn't happen, but
        // recover gracefully by returning a minimal stub.
        return gh.sendJson(res, 200, { vault: ctx.vault, config: { id: vaultId, name: ctx.vault.name, invites: [] } });
      }
      // Hide invites for non-owners
      const filteredConfig = (ctx.vault.owner === ctx.user.id)
        ? config
        : { ...config, invites: [] };

      // Resolve member usernames for the UI
      const accounts = await gh.readAccounts();
      const memberList = (ctx.vault.members || []).map(mid => {
        const a = (accounts?.accounts || []).find(x => x.id === mid);
        return a ? {
          id: a.id, username: a.username, displayName: a.displayName,
          isOwner: a.id === ctx.vault.owner
        } : { id: mid, username: "(unknown)", displayName: "(unknown)", isOwner: false };
      });

      return gh.sendJson(res, 200, { vault: ctx.vault, config: filteredConfig, members: memberList });
    }

    if (req.method === "POST") {
      const ctx = await auth.requireVaultOwner(req, vaultId);
      const { name, color, description } = await gh.readJson(req);
      if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 80)) {
        return gh.sendJson(res, 400, { error: "Vault-Name ungültig" });
      }
      if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) {
        return gh.sendJson(res, 400, { error: "Farbe muss #rrggbb sein" });
      }
      if (description !== undefined && typeof description !== "string") {
        return gh.sendJson(res, 400, { error: "Beschreibung ungültig" });
      }

      const idx = ctx.vaultsIndex;
      const vault = idx.vaults.find(v => v.id === vaultId);
      const config = await gh.readVaultConfig(vaultId) || { id: vaultId, name: vault.name, invites: [] };

      if (name) { vault.name = name.trim(); config.name = vault.name; }
      if (color) vault.color = color;
      if (description !== undefined) config.description = description;

      const refSha = await gh.getRefSha();
      const baseCommit = await gh.getCommit(refSha);
      const indexBlob  = await gh.createBlob(gh.utf8ToB64(gh.buildVaultsIndex(idx)));
      const configBlob = await gh.createBlob(gh.utf8ToB64(gh.buildVaultConfig(config)));
      const treeResult = await gh.createTree(baseCommit.tree.sha, [
        { path: gh.VAULTS_INDEX_FILE, mode: "100644", type: "blob", sha: indexBlob.sha },
        { path: gh.vaultConfigPath(vaultId), mode: "100644", type: "blob", sha: configBlob.sha }
      ]);
      await auth.loadUserContext(ctx.user);
      const author = (ctx.user.github && ctx.user.github.commitEmail)
        ? { name: ctx.user.github.login || ctx.user.username, email: ctx.user.github.commitEmail }
        : null;
      const commit = await gh.createCommit(
        `[${ctx.user.username}] Vault aktualisiert: ${vault.name}`,
        treeResult.sha, refSha, author
      );
      await gh.updateRef(commit.sha);

      return gh.sendJson(res, 200, { vault });
    }

    if (req.method === "DELETE") {
      const ctx = await auth.requireVaultOwner(req, vaultId);
      const idx = ctx.vaultsIndex;

      // Remove from index
      idx.vaults = (idx.vaults || []).filter(v => v.id !== vaultId);

      // Delete every blob under vaults/<vid>/ by listing the tree and
      // marking each with sha:null.
      const tree = await gh.getTree();
      const prefix = `vaults/${vaultId}/`;
      const entries = [
        { path: gh.VAULTS_INDEX_FILE, mode: "100644", type: "blob",
          sha: (await gh.createBlob(gh.utf8ToB64(gh.buildVaultsIndex(idx)))).sha }
      ];
      for (const entry of (tree.tree || [])) {
        if (entry.type !== "blob") continue;
        if (!entry.path.startsWith(prefix)) continue;
        entries.push({ path: entry.path, mode: "100644", type: "blob", sha: null });
      }

      const refSha = await gh.getRefSha();
      const baseCommit = await gh.getCommit(refSha);
      const treeResult = await gh.createTree(baseCommit.tree.sha, entries);
      await auth.loadUserContext(ctx.user);
      const author = (ctx.user.github && ctx.user.github.commitEmail)
        ? { name: ctx.user.github.login || ctx.user.username, email: ctx.user.github.commitEmail }
        : null;
      const commit = await gh.createCommit(
        `[${ctx.user.username}] Vault gelöscht: ${ctx.vault.name}`,
        treeResult.sha, refSha, author
      );
      await gh.updateRef(commit.sha);

      return gh.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return gh.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
