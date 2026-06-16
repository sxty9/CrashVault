// One-time migration: repo (GitHub-as-database, JS-global files) → server disk
// (/var/lib/crashvault, plain JSON, vault-based layout).
//
// Reads the current repo data in the legacy pre-vault layout
// (accounts.js, modules/registry.js, modules/<mid>/data.js + files/) and writes
// the vault-based JSON tree the new api/_store.js expects, creating a default
// vault for the admin account — i.e. it performs the old lazy
// ensureVaultsMigration deterministically, once.
//
// Idempotent guard: refuses to run if vaults/index.json already exists in
// DATA_DIR unless --force is passed. Reads the repo read-only.
//
//   node scripts/migrate-to-disk.js [--force]

"use strict";

const fs = require("fs");
const path = require("path");
const store = require("../api/_store.js");

const REPO = path.join(__dirname, "..");
const FORCE = process.argv.includes("--force");

// Parse a `window.CRASHVAULT_X = { ... };` file into its object by slicing the
// outermost braces — robust against the comment header and trailing semicolon.
function parseGlobalFile(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) throw new Error(`no JSON object in ${absPath}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function main() {
  if (store.readVaultsIndex() && !FORCE) {
    console.error(`Refusing: ${store.DATA_DIR}/vaults/index.json already exists. Use --force to overwrite.`);
    process.exit(1);
  }
  console.log(`Migrating repo → ${store.DATA_DIR}${FORCE ? "  (--force)" : ""}`);

  // --- 1. accounts ---
  const accounts = parseGlobalFile(path.join(REPO, "accounts.js"));
  store.writeAccounts(accounts);
  const admin = (accounts.accounts || []).find(a => a.role === "admin") || (accounts.accounts || [])[0];
  if (!admin) throw new Error("no account found to own the migrated vault");
  console.log(`  accounts.json ← ${accounts.accounts.length} account(s); owner = ${admin.username} (${admin.id})`);

  // --- 2. default vault for the admin ---
  const vaultId = store.genVaultId();
  const now = new Date().toISOString();
  const vaultName = admin.displayName ? `${admin.displayName}s Vault` : "Mein erster Vault";
  store.writeVaultsIndex({
    vaults: [{
      id: vaultId, name: vaultName, color: "#38bdf8",
      owner: admin.id, members: [admin.id], createdAt: now
    }]
  });
  store.writeVaultConfig({ id: vaultId, name: vaultName, description: "", invites: [] });
  console.log(`  vault ${vaultId} "${vaultName}" (owner ${admin.username})`);

  // --- 3. admin user settings (only if absent) ---
  if (!store.readJSON(store.userSettingsPath(admin.id))) {
    store.writeUserSettings(admin.id, {});
    console.log(`  users/${admin.id}/settings.json ← defaults`);
  }

  // --- 4. registry ---
  const registry = parseGlobalFile(path.join(REPO, "modules", "registry.js"));
  store.writeRegistry(vaultId, registry);
  console.log(`  registry.json ← ${(registry.modules || []).length} module(s): ${(registry.modules||[]).map(m=>m.id).join(", ")}`);

  // --- 5. every module dir under modules/ → vault module ---
  const modulesDir = path.join(REPO, "modules");
  const moduleDirs = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  for (const mid of moduleDirs) {
    const dataJs = path.join(modulesDir, mid, "data.js");
    if (!fs.existsSync(dataJs)) continue;
    const data = parseGlobalFile(dataJs);
    store.writeModuleData(vaultId, mid, data);
    let nFiles = 0;
    const filesDir = path.join(modulesDir, mid, "files");
    if (fs.existsSync(filesDir)) {
      for (const fname of fs.readdirSync(filesDir)) {
        const abs = path.join(filesDir, fname);
        if (!fs.statSync(abs).isFile()) continue;
        store.writeFileAt(`${store.vaultModuleFilesPrefix(vaultId, mid)}${fname}`, fs.readFileSync(abs));
        nFiles++;
      }
    }
    const inReg = (registry.modules || []).some(m => m.id === mid);
    console.log(`  module "${mid}": ${(data.tiles||[]).length} tile(s), ${nFiles} file(s)${inReg ? "" : "  [not in registry]"}`);
  }

  console.log("Migration complete.");
}

main();
