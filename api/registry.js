// GET  /api/registry?vault=<vid>  → { registry, sha }
// POST /api/registry?vault=<vid>  body: { registry, expectedSha } → { sha }
//
// The per-vault module registry lives at vaults/<vid>/modules/registry.json on
// the server disk. Membership in the vault is required for both directions.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("vault");
    if (!store.validVaultId(vaultId)) return store.sendJson(res, 400, { error: "vault query param invalid" });
    await auth.requireVaultMember(req, vaultId);
    const regPath = store.vaultModuleRegistryPath(vaultId);

    if (req.method === "GET") {
      const registry = store.readRegistry(vaultId) || { modules: [] };
      return store.sendJson(res, 200, { registry, sha: store.fileSha(regPath) });
    }

    if (req.method === "POST") {
      const { registry, expectedSha } = await store.readJson(req);
      if (!registry || !Array.isArray(registry.modules)) {
        return store.sendJson(res, 400, { error: "Invalid registry payload" });
      }
      for (const m of registry.modules) {
        if (!store.validModuleId(m.id)) return store.sendJson(res, 400, { error: `Ungültige Modul-ID: ${m.id}` });
      }
      const currentSha = store.fileSha(regPath);
      if (expectedSha && currentSha !== expectedSha) {
        return store.sendJson(res, 409, { error: "Daten wurden inzwischen geändert. Bitte ↻ Neu laden und nochmal speichern." });
      }
      const sha = store.writeRegistry(vaultId, registry);
      return store.sendJson(res, 200, { sha });
    }

    res.setHeader("Allow", "GET, POST");
    return store.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return store.sendError(res, e);
  }
};
