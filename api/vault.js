// GET    /api/vault?id=<vid>   → { vault, config, members? }
// POST   /api/vault?id=<vid>   body: { name?, color?, description? } → { vault }
// DELETE /api/vault?id=<vid>   → { ok: true }   (owner-only, drops the whole vault)
//
// GET returns BOTH the index entry (members) AND the per-vault config.
// Invite codes are stripped from `config.invites` for non-owners. Member
// usernames are resolved against accounts.json for display.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");

    if (req.method === "GET") {
      const ctx = await auth.requireVaultMember(req, vaultId);
      const config = store.readVaultConfig(vaultId);
      if (!config) {
        return store.sendJson(res, 200, { vault: ctx.vault, config: { id: vaultId, name: ctx.vault.name, invites: [] } });
      }
      const filteredConfig = (ctx.vault.owner === ctx.user.id) ? config : { ...config, invites: [] };

      const accounts = store.readAccounts();
      const memberList = (ctx.vault.members || []).map(mid => {
        const a = (accounts?.accounts || []).find(x => x.id === mid);
        return a ? {
          id: a.id, username: a.username, displayName: a.displayName,
          isOwner: a.id === ctx.vault.owner
        } : { id: mid, username: "(unknown)", displayName: "(unknown)", isOwner: false };
      });

      return store.sendJson(res, 200, { vault: ctx.vault, config: filteredConfig, members: memberList });
    }

    if (req.method === "POST") {
      const ctx = await auth.requireVaultOwner(req, vaultId);
      const { name, color, description } = await store.readJson(req);
      if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 80)) {
        return store.sendJson(res, 400, { error: "Vault-Name ungültig" });
      }
      if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) {
        return store.sendJson(res, 400, { error: "Farbe muss #rrggbb sein" });
      }
      if (description !== undefined && typeof description !== "string") {
        return store.sendJson(res, 400, { error: "Beschreibung ungültig" });
      }

      const idx = ctx.vaultsIndex;
      const vault = idx.vaults.find(v => v.id === vaultId);
      const config = store.readVaultConfig(vaultId) || { id: vaultId, name: vault.name, invites: [] };

      if (name) { vault.name = name.trim(); config.name = vault.name; }
      if (color) vault.color = color;
      if (description !== undefined) config.description = description;

      store.writeVaultsIndex(idx);
      store.writeVaultConfig(config);
      return store.sendJson(res, 200, { vault });
    }

    if (req.method === "DELETE") {
      const ctx = await auth.requireVaultOwner(req, vaultId);
      const idx = ctx.vaultsIndex;
      idx.vaults = (idx.vaults || []).filter(v => v.id !== vaultId);
      store.writeVaultsIndex(idx);
      store.removeDirUnder(`vaults/${vaultId}`);
      return store.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return store.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return store.sendError(res, e);
  }
};
