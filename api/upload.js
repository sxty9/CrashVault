// POST /api/upload?path=modules/<id>/files/<name>
//   Body: raw binary (Content-Type: application/octet-stream)  → { path, sha }
//   Or:   JSON { path, base64 }                                 → { path, sha }
//
// The path MUST live under modules/<id>/files/ — uploads outside this prefix
// are rejected so a module can never overwrite another module's file or
// reserved files like data.js/registry.js.

const gh = require("./_github.js");
const auth = require("./_auth.js");

function validUploadPath(path) {
  if (!path || typeof path !== "string") return false;
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return false;
  const m = path.match(/^modules\/([a-z0-9][a-z0-9_-]{0,40})\/files\/[^/]+$/);
  return !!m;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    await auth.requireAuth(req);

    const contentType = req.headers["content-type"] || "";

    if (contentType === "application/octet-stream") {
      const url = new URL(req.url, `http://${req.headers.host || "x"}`);
      const path = url.searchParams.get("path");
      if (!validUploadPath(path)) {
        return gh.sendJson(res, 400, { error: "Pfad muss unter modules/<id>/files/ liegen" });
      }

      const chunks = [];
      let totalSize = 0;
      const MAX_SIZE = 50 * 1024 * 1024;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_SIZE) return gh.sendJson(res, 413, { error: "Datei zu groß (max 50 MB)" });
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      const blob = await gh.createBlob(buf.toString("base64"));
      return gh.sendJson(res, 200, { path, sha: blob.sha });
    }

    const { path, base64 } = await gh.readJson(req);
    if (!validUploadPath(path) || !base64) {
      return gh.sendJson(res, 400, { error: "Pfad muss unter modules/<id>/files/ liegen + base64 required" });
    }
    const blob = await gh.createBlob(base64);
    return gh.sendJson(res, 200, { path, sha: blob.sha });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
