// POST   /api/vault-invite?id=<vid>   body: { expiresInDays?, maxUses? } → { invite }
// DELETE /api/vault-invite?id=<vid>&code=<c>                              → { ok }
//
// Owner-only. Invite codes are URL-safe random (~16 chars). Default
// expiresInDays=30, maxUses=1.

const crypto = require("crypto");
const store = require("./_store.js");
const auth = require("./_auth.js");

const MAX_INVITES_PER_VAULT = 50; // soft cap to keep config small

function genCode() {
  return crypto.randomBytes(12).toString("base64url");
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");
    const ctx = await auth.requireVaultOwner(req, vaultId);
    const config = store.readVaultConfig(vaultId) || { id: vaultId, name: ctx.vault.name, invites: [] };

    if (req.method === "POST") {
      const { expiresInDays, maxUses } = await store.readJson(req);
      const ttlDays = Math.min(Math.max(parseInt(expiresInDays, 10) || 30, 1), 365);
      const uses = (maxUses === null || maxUses === undefined) ? 1 : Math.max(parseInt(maxUses, 10) || 1, 1);
      const now = new Date();
      const invite = {
        code: genCode(),
        createdBy: ctx.user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlDays * 86400000).toISOString(),
        maxUses: uses,
        uses: 0
      };
      config.invites = (config.invites || []).filter(i => new Date(i.expiresAt) > now);
      if (config.invites.length >= MAX_INVITES_PER_VAULT) {
        return store.sendJson(res, 429, { error: `Maximal ${MAX_INVITES_PER_VAULT} aktive Invites pro Vault` });
      }
      config.invites.push(invite);
      store.writeVaultConfig(config);
      return store.sendJson(res, 200, { invite });
    }

    if (req.method === "DELETE") {
      const code = url.searchParams.get("code");
      if (!code) return store.sendJson(res, 400, { error: "code-Param fehlt" });
      const before = (config.invites || []).length;
      config.invites = (config.invites || []).filter(i => i.code !== code);
      if (config.invites.length === before) return store.sendJson(res, 404, { error: "Invite nicht gefunden" });
      store.writeVaultConfig(config);
      return store.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "POST, DELETE");
    return store.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return store.sendError(res, e);
  }
};
