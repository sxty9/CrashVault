// POST /api/ingest-commit?vault=<vid>
//   Body: { items: [{ token, targetModuleId?, newModuleName?, category, finalName }] }
//   → { placed, modulesCreated, errors }
//
// Places the confirmed staged files: creates any proposed new modules in the
// registry, moves each staged file from _inbox into
// vaults/<vid>/modules/<mid>/files/<category>/<finalName>, and appends an audit
// line to vaults/<vid>/_ingest_log.jsonl. One registry write at the end.

const crypto = require("crypto");
const store = require("./_store.js");
const auth = require("./_auth.js");
const cats = require("./_categories.js");

function sanitizeFinal(name) {
  const n = String(name || "datei")
    .replace(/[\/\\\x00-\x1f]/g, "_")
    .replace(/\.\.+/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return n || "datei";
}

function slugify(name) {
  let s = String(name || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!s || !/^[a-z0-9]/.test(s)) s = "m" + (s || crypto.randomBytes(2).toString("hex"));
  return s.slice(0, 41);
}

// Find the staged file for a token (basename "<token>__<name>").
function findStaged(vaultId, token) {
  if (!/^[a-f0-9]{8,32}$/.test(token || "")) return null;
  const files = store.listFilesUnder(`vaults/${vaultId}/_inbox`);
  return files.find(p => p.split("/").pop().startsWith(token + "__")) || null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return store.sendJson(res, 405, { error: "Method not allowed" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("vault");
    if (!store.validVaultId(vaultId)) return store.sendJson(res, 400, { error: "vault query param invalid" });
    const ctx = await auth.requireVaultMember(req, vaultId);

    const { items } = await store.readJson(req);
    if (!Array.isArray(items) || !items.length) return store.sendJson(res, 400, { error: "items[] erforderlich" });

    const registry = store.readRegistry(vaultId) || { modules: [] };
    const existingIds = new Set(registry.modules.map(m => m.id));
    const newNameToId = new Map(); // dedupe new modules within this batch
    let modulesCreated = 0;
    const placed = [];
    const errors = [];

    for (const item of items) {
      try {
        const category = cats.isValidCategory(item.category) ? item.category : cats.DEFAULT_CATEGORY;
        const finalName = sanitizeFinal(item.finalName);

        // Resolve target module id (existing, or create from newModuleName).
        let moduleId = item.targetModuleId;
        if (!moduleId || !existingIds.has(moduleId)) {
          const wanted = (item.newModuleName || "").trim();
          if (!wanted) { errors.push({ token: item.token, error: "kein Zielmodul" }); continue; }
          if (newNameToId.has(wanted)) {
            moduleId = newNameToId.get(wanted);
          } else {
            let id = slugify(wanted), n = 1;
            while (existingIds.has(id)) id = `${slugify(wanted)}-${++n}`;
            registry.modules.push({ id, name: wanted.slice(0, 80), color: "#38bdf8", createdAt: new Date().toISOString() });
            existingIds.add(id);
            newNameToId.set(wanted, id);
            modulesCreated++;
            moduleId = id;
          }
        }
        if (!store.validModuleId(moduleId)) { errors.push({ token: item.token, error: "Modul-ID ungültig" }); continue; }

        // Locate + move the staged file.
        const staged = findStaged(vaultId, item.token);
        if (!staged) { errors.push({ token: item.token, error: "Staging-Datei nicht gefunden (abgelaufen?)" }); continue; }
        const buf = store.readFileAt(staged);
        if (buf == null) { errors.push({ token: item.token, error: "Staging-Datei leer" }); continue; }

        const destRel = `vaults/${vaultId}/modules/${moduleId}/files/${category}/${finalName}`;
        store.writeFileAt(destRel, buf);
        store.removeFileAt(staged);

        store.appendLine(`vaults/${vaultId}/_ingest_log.jsonl`, JSON.stringify({
          ts: new Date().toISOString(),
          actor: item.autoAccepted ? "ai" : "ai+confirm",
          user: ctx.user.username,
          dst: destRel,
          moduleId, category, filename: finalName,
          confidence: typeof item.confidence === "number" ? item.confidence : null,
          sha256: crypto.createHash("sha256").update(buf).digest("hex")
        }));

        placed.push({ token: item.token, path: destRel, moduleId, category });
      } catch (e) {
        errors.push({ token: item && item.token, error: String(e.message || e).slice(0, 120) });
      }
    }

    if (modulesCreated) store.writeRegistry(vaultId, registry);

    return store.sendJson(res, 200, { placed: placed.length, modulesCreated, items: placed, errors });
  } catch (e) {
    return store.sendError(res, e);
  }
};
