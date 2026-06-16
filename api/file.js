// GET /api/file?path=vaults/<vid>/modules/<mid>/files/<name>  → binary content
//
// Reads attachment files from the server disk. Restricted to the per-module
// files/ tree so nothing else under the data dir can be served. Deliberately
// not auth-gated: attachments are opened via window.open() which can't attach
// an Authorization header, and _store.resolveRel already confines the path to
// the data dir.

const store = require("./_store.js");

const MIME = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  m4a: "audio/mp4", mp3: "audio/mpeg", mp4: "video/mp4",
  wav: "audio/wav", ogg: "audio/ogg", webm: "video/webm",
  mov: "video/quicktime", zip: "application/zip"
};

// vaults/<vid>/modules/<mid>/files/<name>  — with one optional <category>/ level.
const FILE_PATH_RE =
  /^vaults\/v_[a-z0-9]{6,40}\/modules\/[a-z0-9][a-z0-9_-]{0,40}\/files\/(?:[^/]+\/)?[^/]+$/;

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const path = url.searchParams.get("path");
    if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
      return store.sendJson(res, 400, { error: "Invalid path" });
    }
    if (!FILE_PATH_RE.test(path)) {
      return store.sendJson(res, 400, { error: "Pfad muss unter vaults/<vid>/modules/<mid>/files/ liegen" });
    }
    const buf = store.readFileAt(path);
    if (buf == null) return store.sendJson(res, 404, { error: "Not found" });

    const ext = (path.split(".").pop() || "").toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const filename = path.split("/").pop();

    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    res.end(buf);
  } catch (e) {
    return store.sendError(res, e);
  }
};
