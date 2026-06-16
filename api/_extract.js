// Text-preview extraction for the AI material import. Pulls a short, capped
// chunk of text out of an uploaded file so Claude can classify it. Mirrors
// BWL_Ult's preview.py limits. Best-effort: any failure degrades to a
// filename-only preview with a note (the classifier then leans on the name +
// low confidence → review queue).

"use strict";

const path = require("path");

const MAX_CHARS = 4000;
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".tex", ".html", ".htm", ".json", ".rtf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

// Returns { filename, ext, size, extractor, text, note }.
async function extractPreview(buf, filename) {
  const ext = path.extname(filename || "").toLowerCase();
  const out = { filename, ext, size: buf ? buf.length : 0, extractor: "filename-only", text: "", note: "" };

  try {
    if (ext === ".pdf") {
      const pdf = require("pdf-parse");
      const data = await pdf(buf, { max: 3 }); // first 3 pages is plenty to classify
      out.text = (data.text || "").replace(/\s+\n/g, "\n").trim().slice(0, MAX_CHARS);
      out.extractor = "pdf";
      if (!out.text) out.note = "[PDF ohne extrahierbaren Text — vermutlich gescannt]";
    } else if (ext === ".docx") {
      const mammoth = require("mammoth");
      const r = await mammoth.extractRawText({ buffer: buf });
      out.text = (r.value || "").trim().slice(0, MAX_CHARS);
      out.extractor = "docx";
    } else if (TEXT_EXT.has(ext)) {
      let t = buf.toString("utf8");
      if (ext === ".html" || ext === ".htm") {
        t = t.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
      }
      out.text = t.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
      out.extractor = "text";
    } else if (IMAGE_EXT.has(ext)) {
      out.extractor = "image";
      out.note = "[Bilddatei, kein OCR — Klassifikation nur über Dateiname]";
    } else {
      out.note = `[kein Text-Extraktor für ${ext || "unbekannt"} — Klassifikation nur über Dateiname]`;
    }
  } catch (e) {
    out.note = `[Extraktion fehlgeschlagen: ${String(e.message || e).slice(0, 80)}]`;
  }
  return out;
}

module.exports = { extractPreview, MAX_CHARS };
