// CrashVault server-side storage layer (replaces api/_github.js).
//
// All persistent state lives on the server's local disk under DATA_DIR — the
// repo holds only code. This is the self-host successor to the old
// GitHub-as-database design (a relic of stateless Vercel). Data files are plain
// JSON; the frontend never loads them directly (it goes through /api/*), so the
// on-disk format is an implementation detail.
//
// Concurrency: instead of a git commit SHA we use a sha256 of the target file's
// bytes as an optimistic-lock token. GET returns it; POST may pass it as
// `expectedSha` and we 409 on mismatch — same contract the frontend already speaks.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.CRASHVAULT_DATA_DIR || "/var/lib/crashvault";

// ============================================================
// Path resolution — every relative path is confined to DATA_DIR. Traversal
// (`..`, absolute, backslashes) is rejected: this is the security boundary now
// that arbitrary files would otherwise be reachable on a real filesystem.
// ============================================================
function resolveRel(rel) {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("..")) {
    const e = new Error("invalid storage path"); e.status = 400; throw e;
  }
  const abs = path.normalize(path.join(DATA_DIR, rel));
  if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + path.sep)) {
    const e = new Error("storage path escapes data dir"); e.status = 400; throw e;
  }
  return abs;
}

function ensureParent(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
}

let _tmpCounter = 0;
function atomicWrite(abs, buf) {
  ensureParent(abs);
  const tmp = `${abs}.${process.pid}.${Date.now()}.${_tmpCounter++}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs); // atomic on the same filesystem
}

// ============================================================
// Generic JSON / file primitives
// ============================================================
function readJSON(rel) {
  let raw;
  try { raw = fs.readFileSync(resolveRel(rel), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  return JSON.parse(raw);
}

// Writes `obj` as pretty JSON, stamping _meta.lastSaved. Returns the new sha.
function writeJSON(rel, obj) {
  const withMeta = { ...obj, _meta: { ...(obj._meta || {}), lastSaved: new Date().toISOString() } };
  const text = JSON.stringify(withMeta, null, 2) + "\n";
  atomicWrite(resolveRel(rel), Buffer.from(text, "utf8"));
  return shaOf(text);
}

function writeFileAt(rel, buf) { atomicWrite(resolveRel(rel), buf); }
function readFileAt(rel) {
  try { return fs.readFileSync(resolveRel(rel)); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function removeFileAt(rel) {
  try { fs.unlinkSync(resolveRel(rel)); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
function exists(rel) { return fs.existsSync(resolveRel(rel)); }

// Recursively list relative file paths under a directory (posix-style, relative
// to DATA_DIR). Returns [] when the dir is missing.
function listFilesUnder(relDir) {
  const absDir = resolveRel(relDir);
  const out = [];
  function walk(abs) {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const ent of ents) {
      const child = path.join(abs, ent.name);
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile()) out.push(path.relative(DATA_DIR, child).split(path.sep).join("/"));
    }
  }
  walk(absDir);
  return out;
}

function appendLine(rel, line) {
  const abs = resolveRel(rel);
  ensureParent(abs);
  fs.appendFileSync(abs, line.endsWith("\n") ? line : line + "\n");
}

// ============================================================
// Concurrency token: sha256 of a file's current bytes (short hex). Missing file
// → null. The frontend treats it as an opaque string, so any stable digest works.
// ============================================================
function shaOf(data) {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 40);
}
function fileSha(rel) {
  const buf = readFileAt(rel);
  return buf == null ? null : shaOf(buf);
}

// ============================================================
// HTTP utils — copied verbatim from the old _github.js so handlers keep working.
// ============================================================
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ""; req.setEncoding("utf8");
    req.on("data", c => { raw += c; if (raw.length > 9 * 1024 * 1024) reject(new Error("payload too large")); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}
function sendError(res, e) {
  const status = e.status || 500;
  sendJson(res, status, { error: e.message || String(e) });
}
function utf8ToB64(str) { return Buffer.from(str, "utf8").toString("base64"); }
function b64ToUtf8(b64) { return Buffer.from(b64, "base64").toString("utf8"); }

// ============================================================
// Id validation — unchanged from _github.js.
// ============================================================
const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const USERNAME_RE  = /^[a-z0-9][a-z0-9_-]{1,32}$/;
const VAULT_ID_RE  = /^v_[a-z0-9]{6,40}$/;
const USER_ID_RE   = /^u_[a-z0-9]{6,40}$/;
function validModuleId(id) { return typeof id === "string" && MODULE_ID_RE.test(id); }
function validUsername(u)  { return typeof u === "string" && USERNAME_RE.test(u); }
function validVaultId(id)  { return typeof id === "string" && VAULT_ID_RE.test(id); }
function validUserId(id)   { return typeof id === "string" && USER_ID_RE.test(id); }

// ============================================================
// Path helpers (now .json on disk).
// ============================================================
const ACCOUNTS_FILE = "accounts.json";
const ACCOUNTS_DEFAULT = { accounts: [], config: { allowSignup: false } };
function userSettingsPath(userId)          { return `users/${userId}/settings.json`; }
const VAULTS_INDEX_FILE = "vaults/index.json";
function vaultConfigPath(vaultId)          { return `vaults/${vaultId}/config.json`; }
function vaultModuleRegistryPath(vaultId)  { return `vaults/${vaultId}/modules/registry.json`; }
function vaultModuleDataPath(vaultId, mid) { return `vaults/${vaultId}/modules/${mid}/data.json`; }
function vaultModuleFilesPrefix(vaultId, mid) { return `vaults/${vaultId}/modules/${mid}/files/`; }

// ============================================================
// High-level domain reads/writes. Read returns null when absent (bootstrap
// signal) except user-settings, which returns an empty skeleton like before.
// ============================================================
function readAccounts() { return readJSON(ACCOUNTS_FILE); }
function writeAccounts(state) {
  return writeJSON(ACCOUNTS_FILE, {
    accounts: state.accounts || [],
    config: state.config || { allowSignup: false }
  });
}

function readUserSettings(userId) {
  return readJSON(userSettingsPath(userId))
      || { features: {}, tileLayouts: {}, preferences: {}, github: null };
}
function writeUserSettings(userId, state) {
  return writeJSON(userSettingsPath(userId), {
    features: state.features || {},
    tileLayouts: state.tileLayouts || {},
    preferences: state.preferences || {},
    github: state.github || null
  });
}

function readVaultsIndex() { return readJSON(VAULTS_INDEX_FILE); }
function writeVaultsIndex(state) {
  return writeJSON(VAULTS_INDEX_FILE, { vaults: state.vaults || [] });
}

function readVaultConfig(vaultId) { return readJSON(vaultConfigPath(vaultId)); }
function writeVaultConfig(state) {
  return writeJSON(vaultConfigPath(state.id), {
    id: state.id,
    name: state.name,
    description: state.description || "",
    invites: state.invites || []
  });
}

function readModuleData(vaultId, mid) { return readJSON(vaultModuleDataPath(vaultId, mid)); }
function writeModuleData(vaultId, mid, state) {
  return writeJSON(vaultModuleDataPath(vaultId, mid), {
    id: state.id,
    name: state.name,
    tiles: state.tiles || []
  });
}

function readRegistry(vaultId) { return readJSON(vaultModuleRegistryPath(vaultId)); }
function writeRegistry(vaultId, state) {
  return writeJSON(vaultModuleRegistryPath(vaultId), { modules: state.modules || [] });
}

function genVaultId() {
  return "v_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Recursively delete a directory under the data dir (used to drop a whole vault).
function removeDirUnder(rel) {
  try { fs.rmSync(resolveRel(rel), { recursive: true, force: true }); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}

// Return the vaults a user belongs to, creating a fresh default vault on first
// visit if they have none. Replaces the old lazy ensureVaultsMigration: the
// modules→vaults move is now a one-time deterministic migration script, so all
// this needs to do is guarantee every user lands in at least one vault.
function ensureUserVault(user) {
  const idx = readVaultsIndex() || { vaults: [] };
  idx.vaults = idx.vaults || [];
  const mine = idx.vaults.filter(v => (v.members || []).includes(user.id));
  if (mine.length) return mine;

  const vaultId = genVaultId();
  const name = user.displayName ? `${user.displayName}s Vault` : "Mein erster Vault";
  const vault = {
    id: vaultId, name, color: "#38bdf8",
    owner: user.id, members: [user.id], createdAt: new Date().toISOString()
  };
  idx.vaults.push(vault);
  writeVaultsIndex(idx);
  writeVaultConfig({ id: vaultId, name, description: "", invites: [] });
  if (!readJSON(userSettingsPath(user.id))) writeUserSettings(user.id, {});
  return [vault];
}

module.exports = {
  DATA_DIR,
  // generic
  resolveRel, readJSON, writeJSON, writeFileAt, readFileAt, removeFileAt,
  exists, listFilesUnder, appendLine, shaOf, fileSha,
  // http utils
  readJson, sendJson, sendError, utf8ToB64, b64ToUtf8,
  // validation
  validModuleId, validUsername, validVaultId, validUserId,
  // paths
  ACCOUNTS_FILE, ACCOUNTS_DEFAULT, userSettingsPath, VAULTS_INDEX_FILE, vaultConfigPath,
  vaultModuleRegistryPath, vaultModuleDataPath, vaultModuleFilesPrefix,
  // domain
  readAccounts, writeAccounts, readUserSettings, writeUserSettings,
  readVaultsIndex, writeVaultsIndex, readVaultConfig, writeVaultConfig,
  readModuleData, writeModuleData, readRegistry, writeRegistry,
  genVaultId, removeDirUnder, ensureUserVault
};
