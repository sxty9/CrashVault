// POST /api/vault-join?code=<code>  → { vault }
//
// Looks up the invite code across every vault config (linear scan — no global
// invite index). Bumps the invite's uses counter and adds the caller to the
// vault's members list.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }
    const user = await auth.requireAuth(req);
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const code = url.searchParams.get("code");
    if (!code) return store.sendJson(res, 400, { error: "code-Param fehlt" });

    const idx = store.readVaultsIndex();
    if (!idx) return store.sendJson(res, 404, { error: "Vault system not initialized" });

    let foundVault = null, foundConfig = null, foundInvite = null;
    for (const v of (idx.vaults || [])) {
      const cfg = store.readVaultConfig(v.id);
      if (!cfg || !Array.isArray(cfg.invites)) continue;
      const inv = cfg.invites.find(i => i.code === code);
      if (inv) { foundVault = v; foundConfig = cfg; foundInvite = inv; break; }
    }
    if (!foundVault) return store.sendJson(res, 404, { error: "Invite-Code ungültig oder abgelaufen" });

    if (new Date(foundInvite.expiresAt) <= new Date()) {
      return store.sendJson(res, 410, { error: "Invite-Code ist abgelaufen" });
    }
    if (foundInvite.maxUses && foundInvite.uses >= foundInvite.maxUses) {
      return store.sendJson(res, 410, { error: "Invite-Code wurde bereits maximal oft verwendet" });
    }
    if (foundVault.members.includes(user.id)) {
      return store.sendJson(res, 200, { vault: foundVault, alreadyMember: true });
    }

    foundInvite.uses = (foundInvite.uses || 0) + 1;
    foundVault.members.push(user.id);
    store.writeVaultsIndex(idx);
    store.writeVaultConfig(foundConfig);

    return store.sendJson(res, 200, { vault: foundVault });
  } catch (e) {
    return store.sendError(res, e);
  }
};
