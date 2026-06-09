// CrashVault self-host server.
//
// Replaces the Vercel serverless runtime with a single long-running Node
// process. Two responsibilities:
//   1. Serve a strict allowlist of static frontend files.
//   2. Route /api/* to the same handler files Vercel used — their
//      (req, res) => {} signature is plain Node http, so they run unchanged.
//
// Binds to 127.0.0.1 only: the sole legitimate ingress is the Cloudflare
// tunnel (cloudflared) running on the same host. Nothing should hit this
// port directly from the network.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

// ============================================================
// .env loader — no dependency. Real env (systemd EnvironmentFile, shell
// exports) always wins; .env only fills gaps. Keeps secrets out of the
// process list while staying trivial.
// ============================================================
function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  let raw;
  try { raw = fs.readFileSync(envPath, "utf8"); } catch (e) { return; }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "127.0.0.1";

// ============================================================
// API handler registry — scan api/ once at startup. Exclude `_`-prefixed
// shared modules (they export helpers, not request handlers). The map key
// is the URL subpath after /api/ (e.g. "auth/login", "vault-members").
// ============================================================
const apiHandlers = new Map();
function registerApiDir(absDir, urlPrefix) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      registerApiDir(path.join(absDir, ent.name), urlPrefix + ent.name + "/");
    } else if (ent.isFile() && ent.name.endsWith(".js") && !ent.name.startsWith("_")) {
      const key = urlPrefix + ent.name.slice(0, -3); // drop ".js"
      apiHandlers.set(key, path.join(absDir, ent.name));
    }
  }
}
registerApiDir(path.join(ROOT, "api"), "");

// ============================================================
// Static allowlist. We never fall through to "serve any file" — only the
// frontend assets below are reachable. Everything else (accounts.js,
// vaults/, users/, modules/, .env, server.js, node_modules/, .git/) is
// invisible. This is the security boundary: the whole auth layer would be
// pointless if the data files were directly downloadable.
// ============================================================
const STATIC_EXACT = {
  "/":             "index.html",
  "/index.html":   "index.html",
  "/vault.html":   "vault.html",
  "/module.html":  "module.html",
  "/favicon.ico":  "favicon.ico"
};
const STATIC_PREFIXES = ["/assets/", "/tiles/", "/features/"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".map":  "application/json; charset=utf-8"
};

function sendStatusJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function serveFile(res, absPath, { noCache } = {}) {
  let data;
  try { data = fs.readFileSync(absPath); }
  catch (e) { return sendStatusJson(res, 404, { error: "Not found" }); }
  const ext = path.extname(absPath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  // HTML must never be cached by Cloudflare/browser so deploys take effect
  // instantly. Hashed-free static assets (js/css) get a short cache.
  if (noCache || ext === ".html") {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300");
  }
  res.end(data);
}

// Resolve a static request to a real file inside an allowed prefix dir,
// guarding against path traversal. Returns the absolute path or null.
function resolveStaticPrefix(pathname) {
  for (const prefix of STATIC_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    // Decode + normalize, then ensure the result is still inside ROOT/<dir>.
    let rel;
    try { rel = decodeURIComponent(pathname.slice(1)); } catch (e) { return null; }
    const abs = path.normalize(path.join(ROOT, rel));
    const dirAbs = path.join(ROOT, prefix.slice(1)); // e.g. ROOT/assets/
    if (abs !== dirAbs.replace(/\/$/, "") && !abs.startsWith(dirAbs)) return null;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return abs;
  }
  return null;
}

// ============================================================
// Request dispatch
// ============================================================
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || "x"}`).pathname;
  } catch (e) {
    return sendStatusJson(res, 400, { error: "Bad URL" });
  }

  // --- API routing ---
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const sub = pathname === "/api" ? "" : pathname.slice("/api/".length);
    // Reject traversal and underscore-prefixed segments outright.
    if (sub.includes("..") || sub.split("/").some(s => s.startsWith("_"))) {
      return sendStatusJson(res, 404, { error: "Unknown endpoint" });
    }
    const handlerPath = apiHandlers.get(sub);
    if (!handlerPath) {
      return sendStatusJson(res, 404, { error: `Unknown endpoint: /api/${sub}` });
    }
    let handler;
    try {
      handler = require(handlerPath);
    } catch (e) {
      console.error("Handler load error for", sub, e);
      return sendStatusJson(res, 500, { error: "Handler failed to load" });
    }
    try {
      await handler(req, res);
    } catch (e) {
      console.error("Handler threw for", sub, e);
      if (!res.headersSent) {
        const status = e.status || 500;
        sendStatusJson(res, status, { error: e.message || "Internal error" });
      }
    }
    return;
  }

  // --- Static: exact matches ---
  if (Object.prototype.hasOwnProperty.call(STATIC_EXACT, pathname)) {
    return serveFile(res, path.join(ROOT, STATIC_EXACT[pathname]));
  }

  // --- Static: prefix dirs (assets/tiles/features) ---
  const prefixFile = resolveStaticPrefix(pathname);
  if (prefixFile) return serveFile(res, prefixFile);

  // --- Nothing matched ---
  return sendStatusJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  // Startup self-check: warn loudly if critical env is missing so a
  // misconfigured deploy is obvious in journalctl rather than failing
  // silently on the first request.
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "JWT_SECRET"].filter(k => !process.env[k]);
  console.log(`CrashVault listening on http://${HOST}:${PORT}`);
  console.log(`Registered ${apiHandlers.size} API endpoints`);
  if (missing.length) {
    console.warn(`WARNING: missing env vars: ${missing.join(", ")} — API calls will fail until set.`);
  }
});
