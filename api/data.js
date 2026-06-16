// GET  /api/data?vault=<vid>&module=<mid>  → { state, sha }
// POST /api/data?vault=<vid>&module=<mid>  body: { state, expectedSha, fileShas } → { sha }
//
// Per-module state under a vault, stored at vaults/<vid>/modules/<mid>/data.json
// on the server disk. The `fileShas` paths must all live under
// vaults/<vid>/modules/<mid>/files/ — cross-vault references are rejected. The
// referenced files are written separately by /api/upload before this POST.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("vault");
    const moduleId = url.searchParams.get("module");
    if (!store.validVaultId(vaultId))  return store.sendJson(res, 400, { error: "vault query param invalid" });
    if (!store.validModuleId(moduleId)) return store.sendJson(res, 400, { error: "module query param invalid" });
    await auth.requireVaultMember(req, vaultId);
    const dataPath = store.vaultModuleDataPath(vaultId, moduleId);
    const filePrefix = store.vaultModuleFilesPrefix(vaultId, moduleId);

    if (req.method === "GET") {
      const state = store.readModuleData(vaultId, moduleId); // null if module has no data yet
      return store.sendJson(res, 200, { state, sha: store.fileSha(dataPath) });
    }

    if (req.method === "POST") {
      const { state, expectedSha, fileShas = [] } = await store.readJson(req);
      if (!state || !Array.isArray(state.tiles)) return store.sendJson(res, 400, { error: "Invalid state payload" });

      const currentSha = store.fileSha(dataPath);
      if (expectedSha && currentSha !== expectedSha) {
        return store.sendJson(res, 409, { error: "Daten wurden inzwischen geändert. Bitte ↻ Neu laden und nochmal speichern." });
      }
      // The files themselves are already on disk (written by /api/upload). Here we
      // only enforce that every referenced path stays inside this module.
      for (const f of fileShas) {
        if (!f || !f.path) continue;
        if (!f.path.startsWith(filePrefix)) {
          return store.sendJson(res, 400, { error: `file path außerhalb des Moduls: ${f.path}` });
        }
      }
      const sha = store.writeModuleData(vaultId, moduleId, state);
      return store.sendJson(res, 200, { sha, changes: 1 + fileShas.length });
    }

    res.setHeader("Allow", "GET, POST");
    return store.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return store.sendError(res, e);
  }
};
