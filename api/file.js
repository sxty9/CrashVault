// GET /api/file?path=modules/<id>/files/<name>  → binary file content
//
// Reads files from the repo. Restricted to the modules/ tree so internal repo
// files cannot be served by accident.

const gh = require("./_github.js");

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

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const path = url.searchParams.get("path");
    if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
      return gh.sendJson(res, 400, { error: "Invalid path" });
    }
    if (!/^modules\/[a-z0-9][a-z0-9_-]{0,40}\/files\/[^/]+$/.test(path)) {
      return gh.sendJson(res, 400, { error: "Pfad muss unter modules/<id>/files/ liegen" });
    }
    const c = await gh.getContent(path);
    if (!c) return gh.sendJson(res, 404, { error: "Not found" });
    const b64 = c.content || (await gh.getBlob(c.sha)).content;
    if (!b64) return gh.sendJson(res, 500, { error: "No content from GitHub" });

    const buf = Buffer.from(b64, "base64");
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
    return gh.sendError(res, e);
  }
};
