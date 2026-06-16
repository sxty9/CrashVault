// GET /api/files?vault=<vid>&module=<mid>  → { files: [...] }
//
// Lists every file under vaults/<vid>/modules/<mid>/files/ on the server disk.
// Member of the vault required. Used by the attachment menu inside a Themenliste
// tile so the user can pick already-uploaded files.

const store = require("./_store.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId  = url.searchParams.get("vault");
    const moduleId = url.searchParams.get("module");
    if (!store.validVaultId(vaultId))  return store.sendJson(res, 400, { error: "vault query param invalid" });
    if (!store.validModuleId(moduleId)) return store.sendJson(res, 400, { error: "module query param invalid" });
    await auth.requireVaultMember(req, vaultId);

    const prefix = store.vaultModuleFilesPrefix(vaultId, moduleId);
    const files = store.listFilesUnder(prefix).sort((a, b) => a.localeCompare(b));
    res.setHeader("Cache-Control", "no-store");
    return store.sendJson(res, 200, { files });
  } catch (e) {
    return store.sendError(res, e);
  }
};
