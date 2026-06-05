// CrashVault shared client-side helpers.
// Exposes window.CV = { api, toast, loading, uid, escapeText, escapeAttr, ... }.

(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function escapeText(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function escapeAttr(s) { return escapeText(s).replace(/"/g, "&quot;"); }
  function slugify(s) {
    return String(s).toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  }

  let toastTimer = null;
  function toast(msg, kind) {
    let el = $("#toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast"; el.className = "toast";
      document.body.appendChild(el);
    }
    el.className = "toast show " + (kind || "");
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast " + (kind || ""); }, 3000);
  }

  function loading(text) {
    let overlay = $("#loadingOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "loadingOverlay"; overlay.className = "loading-overlay";
      overlay.innerHTML = `<div class="box" id="loadingText"></div>`;
      document.body.appendChild(overlay);
    }
    if (text == null) overlay.classList.remove("show");
    else { $("#loadingText").textContent = text; overlay.classList.add("show"); }
  }

  // ============================================================
  // Session helpers — JWT in localStorage.
  // ------------------------------------------------------------
  // The session token is set on login/signup and cleared on logout. All API
  // requests through api()/apiJson()/apiPostJson() automatically attach it
  // as a Bearer header. A 401 response means the token is no longer valid;
  // we drop it and surface an `auth-expired` event so the page can route
  // back to the login screen.
  // ============================================================
  const SESSION_KEY = "crashvault-session";
  function getSession() {
    try { return localStorage.getItem(SESSION_KEY) || null; }
    catch (e) { return null; }
  }
  function setSession(token) {
    try { localStorage.setItem(SESSION_KEY, token); } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function withAuthHeaders(opts) {
    const t = getSession();
    if (!t) return opts;
    const headers = Object.assign({}, (opts && opts.headers) || {}, { "Authorization": "Bearer " + t });
    return Object.assign({}, opts || {}, { headers });
  }

  async function api(path, opts) {
    const res = await fetch(path, withAuthHeaders(opts));
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      let body = null;
      try { body = await res.json(); if (body && body.error) msg = body.error; } catch (e) {}
      const err = new Error(msg); err.status = res.status; err.body = body;
      // Drop dead sessions so the page can route back to the login screen.
      if (res.status === 401 && getSession()) {
        clearSession();
        try { window.dispatchEvent(new CustomEvent("crashvault:auth-expired")); } catch (e) {}
      }
      throw err;
    }
    return res;
  }
  async function apiJson(path, opts) { return (await api(path, opts)).json(); }
  async function apiPostJson(path, body) {
    return apiJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  function autosize(ta) { ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 2) + "px"; }

  // ============================================================
  // Anki: client-side helpers — stable card ids + download flow
  // ============================================================
  function ankiCardKey(tileId, topicId, cardId) {
    return (tileId || "t") + ":" + (topicId || "t") + ":" + (cardId || uid());
  }

  // Split a Spruch into front/back at the comma closest to the middle, else at
  // the word boundary closest to the middle. Mirrors the BWL behaviour so
  // exported Sprüche have a sensible Q/A split.
  function splitSpruch(text) {
    text = (text || "").trim();
    if (!text) return null;
    const mid = Math.floor(text.length / 2);
    const commas = [];
    for (let i = 0; i < text.length; i++) if (text[i] === ",") commas.push(i);
    let splitPos = -1;
    if (commas.length) {
      let best = -1, bestDist = Infinity;
      for (const ci of commas) {
        const d = Math.abs(ci - mid);
        if (d < bestDist) { bestDist = d; best = ci; }
      }
      splitPos = best + 1;
    }
    if (splitPos < 0) {
      const spaces = [];
      for (let i = 0; i < text.length; i++) if (text[i] === " ") spaces.push(i);
      if (spaces.length) {
        let best = -1, bestDist = Infinity;
        for (const si of spaces) {
          const d = Math.abs(si - mid);
          if (d < bestDist) { bestDist = d; best = si; }
        }
        splitPos = best;
      }
    }
    if (splitPos < 0) splitPos = mid;
    const front = text.slice(0, splitPos).trim();
    const back = text.slice(splitPos).trim();
    if (!front || !back) return { front: text, back: "..." };
    return { front, back };
  }

  async function downloadApkg(body) {
    try {
      toast("Generiere .apkg…");
      const res = await fetch("/api/anki", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        let msg = `${res.status}`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      let filename = "anki-export.apkg";
      const m = cd.match(/filename\*?=(?:UTF-8'')?([^;\s]+)/i);
      if (m) filename = decodeURIComponent(m[1]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("Export fertig ✓", "ok");
      return true;
    } catch (e) {
      toast("Export fehlgeschlagen: " + e.message, "err");
      return false;
    }
  }

  // ============================================================
  // Features (Plug-in system, per-device settings in localStorage)
  // ------------------------------------------------------------
  // Features extend the app with capabilities. Each Feature registers itself
  // on window.CV_FEATURES[<id>] with:
  //   { label, icon, description, defaultConfig, renderConfig(el, config, save),
  //     test(config) -> {ok, message}, syncModule?(moduleState, config, ctx) }
  // Per-device state (enabled flag + config) is in localStorage so two devices
  // can have different configurations of the same Feature.
  const FEATURES_KEY = "crashvault-features";
  function getAllFeatureStates() {
    try { return JSON.parse(localStorage.getItem(FEATURES_KEY) || "{}"); } catch (e) { return {}; }
  }
  function getFeatureState(id) {
    const all = getAllFeatureStates();
    const feat = (window.CV_FEATURES || {})[id];
    const saved = all[id];
    return {
      enabled: !!(saved && saved.enabled),
      config: Object.assign({}, feat?.defaultConfig || {}, saved?.config || {})
    };
  }
  function saveFeatureState(id, state) {
    const all = getAllFeatureStates();
    all[id] = state;
    try { localStorage.setItem(FEATURES_KEY, JSON.stringify(all)); } catch (e) {}
  }

  window.CV = {
    $, uid, deepClone, escapeText, escapeAttr, slugify,
    toast, loading, api, apiJson, apiPostJson,
    autosize, ankiCardKey, splitSpruch, downloadApkg,
    getFeatureState, saveFeatureState, getAllFeatureStates,
    getSession, setSession, clearSession
  };
})();
