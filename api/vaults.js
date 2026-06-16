// GET  /api/vaults  → { vaults: [...] }   (only vaults this user is a member of)
// POST /api/vaults  body: { name, color? } → { vault }
//
// Lists vaults from the access-control index. A user with no vault yet gets a
// fresh default one created on first GET (store.ensureUserVault).

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const user = await auth.requireAuth(req);

    if (req.method === "GET") {
      const mine = store.ensureUserVault(user);
      return store.sendJson(res, 200, { vaults: mine });
    }

    if (req.method === "POST") {
      const { name, color } = await store.readJson(req);
      if (typeof name !== "string" || !name.trim() || name.length > 80) {
        return store.sendJson(res, 400, { error: "Vault-Name fehlt oder zu lang" });
      }
      // Make sure the user has their default vault before adding another.
      store.ensureUserVault(user);
      const idx = store.readVaultsIndex() || { vaults: [] };

      const vault = {
        id: store.genVaultId(),
        name: name.trim(),
        color: (color && /^#[0-9a-f]{6}$/i.test(color)) ? color : "#38bdf8",
        owner: user.id,
        members: [user.id],
        createdAt: new Date().toISOString()
      };
      idx.vaults.push(vault);
      store.writeVaultsIndex(idx);
      store.writeVaultConfig({ id: vault.id, name: vault.name, description: "", invites: [] });

      return store.sendJson(res, 200, { vault });
    }

    res.setHeader("Allow", "GET, POST");
    return store.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return store.sendError(res, e);
  }
};
