// POST /api/upload?path=vaults/<vid>/modules/<mid>/files/<name>
//   Body: raw binary (Content-Type: application/octet-stream)  → { path, sha }
//   Or:   JSON { path, base64 }                                 → { path, sha }
//
// The path MUST live under vaults/<vid>/modules/<mid>/files/. The caller
// must be a member of the target vault. createBlob alone doesn't add the
// file to a commit — only writes the blob; the data.js POST then references
// the blob's sha to actually attach it.

const gh = require("./_github.js");
const auth = require("./_auth.js");

// vaults/<vid>/modules/<mid>/files/<single-segment filename>
const UPLOAD_PATH_RE =
  /^vaults\/(v_[a-z0-9]{6,40})\/modules\/([a-z0-9][a-z0-9_-]{0,40})\/files\/[^/]+$/;

function parseUploadPath(path) {
  if (!path || typeof path !== "string") return null;
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null;
  const m = path.match(UPLOAD_PATH_RE);
  if (!m) return null;
  return { vaultId: m[1], moduleId: m[2] };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }

    const contentType = req.headers["content-type"] || "";

    if (contentType === "application/octet-stream") {
      const url = new URL(req.url, `http://${req.headers.host || "x"}`);
      const path = url.searchParams.get("path");
      const parsed = parseUploadPath(path);
      if (!parsed) {
        return gh.sendJson(res, 400, { error: "Pfad muss unter vaults/<vid>/modules/<mid>/files/ liegen" });
      }
      await auth.requireVaultMember(req, parsed.vaultId);

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
    const parsed = parseUploadPath(path);
    if (!parsed || !base64) {
      return gh.sendJson(res, 400, { error: "Pfad muss unter vaults/<vid>/modules/<mid>/files/ liegen + base64 required" });
    }
    await auth.requireVaultMember(req, parsed.vaultId);
    const blob = await gh.createBlob(base64);
    return gh.sendJson(res, 200, { path, sha: blob.sha });
  } catch (e) {
    return gh.sendError(res, e);
  }
};
