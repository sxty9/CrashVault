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
    const newNameToId = new Map(); // dedupe new modules within this batch (keyed by slug)
    const seenDest = new Set();    // dest paths used in this batch (avoid in-batch clobber)
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
          // Dedupe by SLUG so "Rechnernetze" / "rechnernetze " converge to one module,
          // and reuse an existing module if its slug already matches (no cross-batch dupes).
          const baseSlug = slugify(wanted);
          if (newNameToId.has(baseSlug)) {
            moduleId = newNameToId.get(baseSlug);
          } else if (existingIds.has(baseSlug)) {
            moduleId = baseSlug;
            newNameToId.set(baseSlug, baseSlug);
          } else {
            let id = baseSlug, n = 1;
            while (existingIds.has(id)) id = `${baseSlug}-${++n}`;
            registry.modules.push({ id, name: wanted.slice(0, 80), color: "#38bdf8", createdAt: new Date().toISOString() });
            existingIds.add(id);
            newNameToId.set(baseSlug, id);
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

        const dir = `vaults/${vaultId}/modules/${moduleId}/files/${category}`;
        let destRel = `${dir}/${finalName}`;
        // Never clobber: if the target already exists on disk or was used earlier
        // in this batch, suffix the name (foo.pdf → foo-2.pdf) instead of overwriting.
        if (store.exists(destRel) || seenDest.has(destRel)) {
          const dot = finalName.lastIndexOf(".");
          const stem = dot > 0 ? finalName.slice(0, dot) : finalName;
          const ext  = dot > 0 ? finalName.slice(dot) : "";
          let n = 2;
          do { destRel = `${dir}/${stem}-${n}${ext}`; n++; } while (store.exists(destRel) || seenDest.has(destRel));
        }
        seenDest.add(destRel);
        const placedName = destRel.split("/").pop();

        store.writeFileAt(destRel, buf);
        store.removeFileAt(staged);

        store.appendLine(`vaults/${vaultId}/_ingest_log.jsonl`, JSON.stringify({
          ts: new Date().toISOString(),
          actor: item.autoAccepted ? "ai" : "ai+confirm",
          user: ctx.user.username,
          dst: destRel,
          moduleId, category, filename: placedName,
          confidence: typeof item.confidence === "number" ? item.confidence : null,
          sha256: crypto.createHash("sha256").update(buf).digest("hex")
        }));

        placed.push({ token: item.token, path: destRel, moduleId, category, renamed: placedName !== finalName ? placedName : undefined });
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
