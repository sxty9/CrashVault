// POST /api/ingest?vault=<vid>&name=<filename>
//   Body: raw binary (application/octet-stream) — one file per request.
//   → { token, name, size, proposedModuleId|newModuleName, proposedCategory,
//       suggestedName, confidence, reasoning, needsReview, note }
//
// Analyzes one uploaded lecture file: extracts a text preview, asks Claude to
// place it (existing module or a proposed new one) + a category, and stages the
// bytes in vaults/<vid>/_inbox/<token>__<name>. Nothing is placed yet — the
// client reviews the proposals and confirms via /api/ingest-commit.

const crypto = require("crypto");
const store = require("./_store.js");
const auth = require("./_auth.js");
const claude = require("./_claude.js");
const cats = require("./_categories.js");
const { extractPreview } = require("./_extract.js");

const MAX_SIZE = 50 * 1024 * 1024;

function sanitizeName(name) {
  return String(name || "datei")
    .replace(/[\/\\\x00-\x1f]/g, "_")
    .replace(/\.\.+/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 160) || "datei";
}

function buildPrompt(preview, modules) {
  const catLines = cats.CATEGORIES.map(c => `- ${c.name}: ${c.desc}`).join("\n");
  const modList = modules.length ? modules.map(m => `${m.id} ("${m.name}")`).join(", ") : "(noch keine Module)";
  return `Du ordnest eine hochgeladene Lernmaterial-Datei in ein MODUL und eine KATEGORIE ein.

VORHANDENE MODULE (nimm das passende per id — wenn keins passt, schlage über new_module_name ein neues vor):
${modList}

KATEGORIEN (exakt eine, Name exakt übernehmen):
${catLines}

DATEINAME: ${preview.filename}
TYP: ${preview.ext || "?"} (${preview.size} Bytes)${preview.note ? "\nHINWEIS: " + preview.note : ""}
VORSCHAU (gekürzt):
"""
${preview.text || "(kein Text extrahierbar — nutze den Dateinamen)"}
"""

Schema (module_id ODER new_module_name gesetzt, das andere null):
{"module_id":<string|null>,"new_module_name":<string|null>,"category":<string>,"suggested_filename":<string mit Endung>,"confidence":<zahl 0..1>,"reasoning":<kurz, deutsch>}`;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("vault");
    const name = sanitizeName(url.searchParams.get("name"));
    if (!store.validVaultId(vaultId)) return store.sendJson(res, 400, { error: "vault query param invalid" });
    await auth.requireVaultMember(req, vaultId);

    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_SIZE) return store.sendJson(res, 413, { error: "Datei zu groß (max 50 MB)" });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) return store.sendJson(res, 400, { error: "Leere Datei" });

    const preview = await extractPreview(buf, name);
    const registry = store.readRegistry(vaultId) || { modules: [] };

    let prop;
    try {
      prop = await claude.invokeClaudeJson(buildPrompt(preview, registry.modules));
    } catch (e) {
      return store.sendJson(res, e.status === 503 ? 503 : 502, { error: "KI-Analyse fehlgeschlagen: " + e.message });
    }

    const existing = registry.modules.find(m => m.id === prop.module_id);
    const category = cats.isValidCategory(prop.category) ? prop.category : cats.DEFAULT_CATEGORY;
    const confidence = Math.max(0, Math.min(1, Number(prop.confidence) || 0));
    const needsReview =
      (!existing && !prop.new_module_name) ||
      !cats.isValidCategory(prop.category) ||
      confidence < cats.CONFIDENCE_THRESHOLD;

    // Stage the bytes. token__name keeps the original name recoverable.
    const token = crypto.randomBytes(8).toString("hex");
    store.writeFileAt(`vaults/${vaultId}/_inbox/${token}__${name}`, buf);

    return store.sendJson(res, 200, {
      token, name, size: buf.length, ext: preview.ext, extractor: preview.extractor, note: preview.note,
      proposedModuleId: existing ? existing.id : null,
      newModuleName: existing ? null : (prop.new_module_name || null),
      proposedCategory: category,
      suggestedName: sanitizeName(prop.suggested_filename || name),
      confidence,
      reasoning: String(prop.reasoning || "").slice(0, 500),
      needsReview
    });
  } catch (e) {
    return store.sendError(res, e);
  }
};
