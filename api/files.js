// GET /api/files?module=<id>  → { files: ["modules/<id>/files/foo.pdf", ...] }
//
// Lists every file under modules/<id>/files/. Used by the attachment menu
// inside a Themenliste tile so the user can pick already-uploaded files.

const gh = require("./_github.js");
const auth = require("./_auth.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    await auth.requireAuth(req);
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const moduleId = url.searchParams.get("module");
    if (!gh.validModuleId(moduleId)) return gh.sendJson(res, 400, { error: "module query param invalid" });

    const prefix = `modules/${moduleId}/files/`;
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
