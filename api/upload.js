// POST /api/upload?path=vaults/<vid>/modules/<mid>/files/<name>
//   Body: raw binary (Content-Type: application/octet-stream)  → { path, sha }
//   Or:   JSON { path, base64 }                                 → { path, sha }
//
// Writes the file straight to the server disk under
// vaults/<vid>/modules/<mid>/files/ (one optional category subfolder allowed).
// The caller must be a member of the target vault. The module's data.json POST
// then references the path so the attachment shows up in a tile.

const store = require("./_store.js");
const auth = require("./_auth.js");

// vaults/<vid>/modules/<mid>/files/<name>  — with one optional <category>/ level.
const UPLOAD_PATH_RE =
  /^vaults\/(v_[a-z0-9]{6,40})\/modules\/([a-z0-9][a-z0-9_-]{0,40})\/files\/(?:[^/]+\/)?[^/]+$/;

function parseUploadPath(path) {
  if (!path || typeof path !== "string") return null;
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null;
  const m = path.match(UPLOAD_PATH_RE);
  if (!m) return null;
  return { vaultId: m[1], moduleId: m[2] };
}

const MAX_SIZE = 50 * 1024 * 1024;

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }

    const contentType = req.headers["content-type"] || "";

    if (contentType === "application/octet-stream") {
      const url = new URL(req.url, `http://${req.headers.host || "x"}`);
      const path = url.searchParams.get("path");
      const parsed = parseUploadPath(path);
      if (!parsed) {
        return store.sendJson(res, 400, { error: "Pfad muss unter vaults/<vid>/modules/<mid>/files/ liegen" });
      }
      await auth.requireVaultMember(req, parsed.vaultId);

      const chunks = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_SIZE) return store.sendJson(res, 413, { error: "Datei zu groß (max 50 MB)" });
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      store.writeFileAt(path, buf);
      return store.sendJson(res, 200, { path, sha: store.shaOf(buf) });
    }

    const { path, base64 } = await store.readJson(req);
    const parsed = parseUploadPath(path);
    if (!parsed || !base64) {
      return store.sendJson(res, 400, { error: "Pfad muss unter vaults/<vid>/modules/<mid>/files/ liegen + base64 required" });
    }
    await auth.requireVaultMember(req, parsed.vaultId);
    const buf = Buffer.from(base64, "base64");
    if (buf.length > MAX_SIZE) return store.sendJson(res, 413, { error: "Datei zu groß (max 50 MB)" });
    store.writeFileAt(path, buf);
    return store.sendJson(res, 200, { path, sha: store.shaOf(buf) });
  } catch (e) {
    return store.sendError(res, e);
  }
};
