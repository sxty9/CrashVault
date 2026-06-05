// Shared GitHub API helpers for the CrashVault serverless functions.
// All persisted state lives directly in the repo: registry + per-module data
// files, plus per-module file uploads under modules/<id>/files/.

const TOKEN  = process.env.GITHUB_TOKEN;
const OWNER  = process.env.GITHUB_OWNER  || "";
const REPO   = process.env.GITHUB_REPO   || "CrashVault";
const BRANCH = process.env.GITHUB_BRANCH || "main";

function assertToken() {
  if (!TOKEN) {
    const e = new Error("GITHUB_TOKEN env variable missing on the server");
    e.status = 500; throw e;
  }
  if (!OWNER) {
    const e = new Error("GITHUB_OWNER env variable missing on the server");
    e.status = 500; throw e;
  }
}

async function gh(path, opts = {}) {
  assertToken();
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "crashvault-app",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch (e) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const repoBase = () => `/repos/${OWNER}/${REPO}`;

async function getRefSha()   { return (await gh(`${repoBase()}/git/refs/heads/${BRANCH}`)).object.sha; }
async function getCommit(sha){ return gh(`${repoBase()}/git/commits/${sha}`); }
async function getContent(p, ref) {
  const r = ref || BRANCH;
  try { return await gh(`${repoBase()}/contents/${encodeURI(p)}?ref=${encodeURIComponent(r)}`); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
async function getTree()     { return gh(`${repoBase()}/git/trees/${BRANCH}?recursive=1`); }
async function getBlob(sha)  { return gh(`${repoBase()}/git/blobs/${sha}`); }
async function createBlob(content) {
  return gh(`${repoBase()}/git/blobs`, { method: "POST", body: JSON.stringify({ content, encoding: "base64" }) });
}
async function createTree(baseTree, entries) {
  return gh(`${repoBase()}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree: entries }) });
}
// `author` (optional): { name, email } applied to BOTH author and committer
// so the GitHub UI attributes the commit to the user — when their account
// has a linked GitHub identity. Without it, the central Vercel token's
// default identity stands.
async function createCommit(message, tree, parent, author) {
  const body = { message, tree, parents: [parent] };
  if (author && author.name && author.email) {
    body.author = { name: author.name, email: author.email };
    body.committer = { name: author.name, email: author.email };
  }
  return gh(`${repoBase()}/git/commits`, { method: "POST", body: JSON.stringify(body) });
}
async function updateRef(sha) {
  return gh(`${repoBase()}/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha, force: false }) });
}

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
function b64ToUtf8(b64)  { return Buffer.from(b64, "base64").toString("utf8"); }

// Validate a module id — restricts to URL-safe slug characters, blocks traversal.
const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
function validModuleId(id) { return typeof id === "string" && MODULE_ID_RE.test(id); }

// Validate a username — same slug constraints as modules. Lowercase only.
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,32}$/;
function validUsername(u) { return typeof u === "string" && USERNAME_RE.test(u); }

// ============================================================
// accounts.js — the persistent account registry, lives at repo root.
// We read/parse/serialize it from a single place so every auth endpoint
// agrees on the shape. The file format mirrors registry.js:
//   window.CRASHVAULT_ACCOUNTS = { accounts: [...], config: {...}, _meta };
// ============================================================
const ACCOUNTS_FILE = "accounts.js";
const ACCOUNTS_DEFAULT = {
  accounts: [],
  config: { allowSignup: false }
};

function parseAccountsFile(text) {
  const m = text.match(/window\.CRASHVAULT_ACCOUNTS\s*=\s*([\s\S]+?);\s*$/);
  if (!m) throw new Error("accounts.js format unexpected");
  return JSON.parse(m[1]);
}
function buildAccountsFile(state) {
  const dump = {
    accounts: state.accounts || [],
    config: state.config || { allowSignup: false },
    _meta: { lastSaved: new Date().toISOString() }
  };
  return "// Auto-generated by CrashVault. Bitte nicht manuell editieren.\n"
       + "window.CRASHVAULT_ACCOUNTS = " + JSON.stringify(dump, null, 2) + ";\n";
}

// Read the accounts registry. Returns null when the file doesn't exist yet
// (bootstrap state) so the caller can offer the "initialize repo" path.
async function readAccounts() {
  const c = await getContent(ACCOUNTS_FILE);
  if (!c) return null;
  const raw = c.content || (await getBlob(c.sha)).content;
  return parseAccountsFile(b64ToUtf8(raw));
}

// Persist the accounts registry. Atomic commit just like every other write
// path. Optional `author` so we can attribute "[bootstrap]" / "[signup]"
// commits — though for signup we typically commit anonymously since the
// new user has no GitHub identity yet.
async function writeAccounts(state, message, author) {
  const sha = await getRefSha();
  const baseCommit = await getCommit(sha);
  const blob = await createBlob(utf8ToB64(buildAccountsFile(state)));
  const tree = await createTree(baseCommit.tree.sha, [
    { path: ACCOUNTS_FILE, mode: "100644", type: "blob", sha: blob.sha }
  ]);
  const commit = await createCommit(message || "CrashVault: accounts aktualisiert", tree.sha, sha, author);
  await updateRef(commit.sha);
  return commit.sha;
}

// User-settings files live at users/<userId>/settings.js.
function userSettingsPath(userId) { return `users/${userId}/settings.js`; }
function parseUserSettings(text) {
  const m = text.match(/window\.CRASHVAULT_USER\s*=\s*([\s\S]+?);\s*$/);
  if (!m) throw new Error("user settings.js format unexpected");
  return JSON.parse(m[1]);
}
function buildUserSettings(state) {
  const dump = {
    features: state.features || {},
    tileLayouts: state.tileLayouts || {},
    preferences: state.preferences || {},
    _meta: { lastSaved: new Date().toISOString() }
  };
  return "// Auto-generated by CrashVault. Bitte nicht manuell editieren.\n"
       + "window.CRASHVAULT_USER = " + JSON.stringify(dump, null, 2) + ";\n";
}

module.exports = {
  OWNER, REPO, BRANCH,
  gh, getRefSha, getCommit, getContent, getTree, getBlob,
  createBlob, createTree, createCommit, updateRef,
  readJson, sendJson, sendError, repoBase,
  utf8ToB64, b64ToUtf8, validModuleId, validUsername,
  ACCOUNTS_FILE, ACCOUNTS_DEFAULT, parseAccountsFile, buildAccountsFile,
  readAccounts, writeAccounts,
  userSettingsPath, parseUserSettings, buildUserSettings
};
