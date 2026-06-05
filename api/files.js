// GET /api/files?vault=<vid>&module=<mid>  → { files: [...] }
//
// Lists every file under vaults/<vid>/modules/<mid>/files/. Member of the
// vault required. Used by the attachment menu inside a Themenliste tile so
// the user can pick already-uploaded files.

const gh = require("./_github.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId  = url.searchParams.get("vault");
    const moduleId = url.searchParams.get("module");
    if (!gh.validVaultId(vaultId))  return gh.sendJson(res, 400, { error: "vault query param invalid" });
    if (!gh.validModuleId(moduleId)) return gh.sendJson(res, 400, { error: "module query param invalid" });
    await auth.requireVaultMember(req, vaultId);

    const prefix = gh.vaultModuleFilesPrefix(vaultId, moduleId);
    const tree = await gh.getTree();
    const files = (tree.tree || [])
      .filter(e => e.type === "blob" && e.path.startsWith(prefix))
      .map(e => e.path)
      .sort((a, b) => a.localeCompare(b));
    res.setHeader("Cache-Control", "no-store");
    return gh.sendJson(res, 200, { files });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
