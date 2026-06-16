// POST /api/vault-transfer?id=<vid>  body: { toUsername }  → { vault }
//
// Owner-only. Transfers ownership to another existing member.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");
    const ctx = await auth.requireVaultOwner(req, vaultId);

    const { toUsername } = await store.readJson(req);
    if (!store.validUsername(toUsername)) {
      return store.sendJson(res, 400, { error: "Username ungültig" });
    }
    const accounts = store.readAccounts();
    const target = (accounts?.accounts || []).find(a => a.username === toUsername);
    if (!target) return store.sendJson(res, 404, { error: "Kein Account mit diesem Username" });
    if (!ctx.vault.members.includes(target.id)) {
      return store.sendJson(res, 400, { error: "Empfänger ist noch kein Mitglied — erst hinzufügen" });
    }
    if (target.id === ctx.user.id) {
      return store.sendJson(res, 400, { error: "Du bist schon Owner" });
    }

    ctx.vault.owner = target.id;
    store.writeVaultsIndex(ctx.vaultsIndex);
    return store.sendJson(res, 200, { vault: ctx.vault });
  } catch (e) {
    return store.sendError(res, e);
  }
};
