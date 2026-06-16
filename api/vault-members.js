// POST   /api/vault-members?id=<vid>   body: { username }  → { vault }
// DELETE /api/vault-members?id=<vid>&user=<uid|me>         → { vault }
//
// POST is owner-only. DELETE allows the caller to remove themselves
// (`user=me` or matching uid); the owner cannot leave without transferring.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");

    if (req.method === "POST") {
      const ctx = await auth.requireVaultOwner(req, vaultId);
      const { username } = await store.readJson(req);
      if (!store.validUsername(username)) {
        return store.sendJson(res, 400, { error: "Username ungültig" });
      }
      const accounts = store.readAccounts();
      const target = (accounts?.accounts || []).find(a => a.username === username);
      if (!target) return store.sendJson(res, 404, { error: "Kein Account mit diesem Username" });

      const vault = ctx.vault;
      if (vault.members.includes(target.id)) {
        return store.sendJson(res, 409, { error: "Schon Mitglied" });
      }
      vault.members.push(target.id);
      store.writeVaultsIndex(ctx.vaultsIndex);
      return store.sendJson(res, 200, { vault });
    }

    if (req.method === "DELETE") {
      const targetParam = url.searchParams.get("user");
      const ctxMember = await auth.requireVaultMember(req, vaultId);
      const myId = ctxMember.user.id;
      const targetId = (targetParam === "me" || !targetParam) ? myId : targetParam;
      const isSelf = targetId === myId;

      if (!isSelf) {
        if (ctxMember.vault.owner !== myId) {
          return store.sendJson(res, 403, { error: "Nur der Owner darf andere entfernen" });
        }
      } else if (ctxMember.vault.owner === myId) {
        return store.sendJson(res, 400, { error: "Owner kann nicht austreten — erst Ownership übertragen" });
      }

      const vault = ctxMember.vault;
      if (!vault.members.includes(targetId)) {
        return store.sendJson(res, 404, { error: "Kein Mitglied" });
      }
      vault.members = vault.members.filter(uid => uid !== targetId);
      store.writeVaultsIndex(ctxMember.vaultsIndex);
      return store.sendJson(res, 200, { vault });
    }

    res.setHeader("Allow", "POST, DELETE");
    return store.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return store.sendError(res, e);
  }
};
