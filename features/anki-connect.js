// Feature: AnkiConnect
//
// Bidirectional sync between CrashVault and a local Anki via AnkiConnect.
//
// Identity model: every CrashVault-managed Anki note carries
//   - "crashvault"        (so we can find them all)
//   - "cvid:<m/t/p/c>"    (so we can correlate to a CV card)
// No localStorage mapping needed.
//
// Conflict resolution: last-write-wins by mod timestamp.
//
// API surface for the module page:
//   computePlan(moduleState, config) -> { added, updated, deleted, moves,
//                                         dupeDeletes, url, deckRoot }
//     Pure read; no Anki mutations. `updated` items carry a `direction`
//     field ("push" = CV->Anki, "pull" = Anki->CV) so the confirmation
//     dialog can mix both directions in one list.
//   applyPlan(plan, ctx) -> { added, updated, pulled, deleted, moved,
//                              errors }
//     Mutates Anki (and CV for pulls). Caller supplies the (possibly
//     user-filtered) plan returned by computePlan. Per-op try/catch so a
//     single failing card doesn't abandon the rest.

(function () {
  "use strict";

  const { escapeText, escapeAttr, toast } = window.CV;

  // ============================================================
  // AnkiConnect transport
  // ============================================================
  async function invoke(url, action, params = {}) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: 6, params })
      });
    } catch (e) {
      throw new Error(
        `Anki nicht erreichbar (${e.message}). Läuft Anki Desktop mit AnkiConnect-Addon? ` +
        `Origin in webCorsOriginList eingetragen?`
      );
    }
    if (!res.ok) throw new Error(`AnkiConnect HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error("AnkiConnect: " + data.error);
    return data.result;
  }

  // ============================================================
  // Normalize a spruch front/back pair so that splitSpruch's
  // comma-on-front artifact doesn't accumulate through Anki round-trips.
  // splitSpruch always pushes the comma to the front side ("ABC," / "DEFG").
  // Anki stores literally what we send, so the user editing front to "ABC"
  // and us re-pulling+re-pushing would otherwise re-add the comma. Strip
  // any leading/trailing comma fluff on both sides — the next splitSpruch
  // is the authoritative comma placement.
  function normalizeSpruchPair(front, back) {
    return {
      front: (front || "").replace(/^,\s*|,\s*$/g, "").trim(),
      back:  (back  || "").replace(/^,\s*|,\s*$/g, "").trim()
    };
  }

  // ============================================================
  // Collect every "syncable card" from a module's tiles
  // ============================================================
  function collectCards(moduleState, deckRoot) {
    const out = [];
    for (const tile of (moduleState.tiles || [])) {
      if (tile.type === "topic-list") {
        for (const t of (tile.state?.topics || [])) {
          for (const c of (t.cards || [])) {
            if (!c.id || !c.front || !c.front.trim()) continue;
            out.push({
              cvid: `${moduleState.id}/${tile.id}/${t.id}/${c.id}`,
              deck: [deckRoot, moduleState.name, tile.title || "Themen", t.title || "Unbenannt"]
                .filter(Boolean).join("::"),
              front: c.front,
              back: c.back || "",
              mod: c.mod || 0,
              tileType: tile.type,
              writeBack: (front, back) => { c.front = front; c.back = back; c.mod = Date.now(); }
            });
          }
        }
      } else if (tile.type === "spruch-list") {
        const sp = window.CV.splitSpruch;
        for (const s of (tile.state?.items || [])) {
          if (!s.id || !s.text || !s.text.trim()) continue;
          const fb = sp(s.text);
          if (!fb) continue;
          // Strip splitSpruch's comma artifact so the same content on both
          // sides compares equal regardless of which side last edited it.
          const { front, back } = normalizeSpruchPair(fb.front, fb.back);
          out.push({
            cvid: `${moduleState.id}/${tile.id}/${s.id}`,
            deck: [deckRoot, moduleState.name, tile.title || "Sprüche"]
              .filter(Boolean).join("::"),
            front,
            back,
            mod: s.mod || 0,
            tileType: tile.type,
            writeBack: (newFront, newBack) => {
              // Mirror the normalize step on incoming Anki content; rejoin so
              // splitSpruch on the next sync produces the same split.
              const n = normalizeSpruchPair(newFront, newBack);
              s.text = (n.front + ", " + n.back).trim();
              s.mod = Date.now();
            }
          });
        }
      }
    }
    return out;
  }

  // ============================================================
  // computePlan — pure read, no Anki side-effects
  // ============================================================
  async function computePlan(moduleState, config) {
    const url = config.url || "http://127.0.0.1:8765";
    const deckRoot = config.deckRoot || "CrashVault";
    const cvCards = collectCards(moduleState, deckRoot);
    const modulePrefix = moduleState.id + "/";

    const decksToCreate = [...new Set(cvCards.map(c => c.deck))];

    // Pull ALL CV-managed notes from Anki — we then scope them to this module
    // by cvid prefix. Cross-module notes are intentionally ignored: syncing
    // module B must never delete module A's cards in Anki.
    const allNoteIds = await invoke(url, "findNotes", { query: "tag:crashvault" });
    const allNotes = allNoteIds.length
      ? await invoke(url, "notesInfo", { notes: allNoteIds })
      : [];

    // Group by cvid first so we can detect duplicates (multiple Anki notes
    // sharing the same cvid — usually from interrupted retries) and pick a
    // canonical one (highest mod ts).
    const allByCvid = new Map(); // cvid → note[]
    for (const note of allNotes) {
      const tag = (note.tags || []).find(t => t.startsWith("cvid:"));
      if (!tag) continue;
      const cvid = tag.substring(5);
      if (!allByCvid.has(cvid)) allByCvid.set(cvid, []);
      allByCvid.get(cvid).push(note);
    }

    // Scope to this module + collect duplicate-cleanup work
    const ankiByCvid = new Map();
    const dupeDeletes = [];
    for (const [cvid, list] of allByCvid) {
      if (!cvid.startsWith(modulePrefix)) continue; // other modules — hands off
      list.sort((a, b) => (b.mod || 0) - (a.mod || 0) || (b.noteId || 0) - (a.noteId || 0));
      const c = list[0];
      ankiByCvid.set(cvid, {
        ankiId: c.noteId,
        front: c.fields?.Front?.value || "",
        back:  c.fields?.Back?.value  || "",
        mod:   c.mod || 0
      });
      for (let i = 1; i < list.length; i++) dupeDeletes.push(list[i].noteId);
    }

    // Deck info for move detection. Fetch all CV cards but only index the ones
    // we actually care about (this module's notes).
    let deckByNoteId = new Map();
    if (ankiByCvid.size) {
      const ourNoteIds = new Set(Array.from(ankiByCvid.values()).map(a => a.ankiId));
      const ankiCardIds = await invoke(url, "findCards", { query: "tag:crashvault" });
      if (ankiCardIds.length) {
        const cardInfos = await invoke(url, "cardsInfo", { cards: ankiCardIds });
        for (const ci of cardInfos) {
          if (!ourNoteIds.has(ci.note)) continue;
          if (!deckByNoteId.has(ci.note)) deckByNoteId.set(ci.note, ci.deckName);
        }
      }
    }

    const plan = {
      url, deckRoot,
      decksToCreate,
      added: [],
      updated: [],   // each: { direction: "push" | "pull", cvid, ... }
      deleted: [],
      moves: [],     // silent — not user-confirmable
      dupeDeletes    // silent cleanup of stray Anki notes with same cvid
    };

    const cvCvids = new Set(cvCards.map(c => c.cvid));

    for (const card of cvCards) {
      const an = ankiByCvid.get(card.cvid);
      if (!an) {
        plan.added.push({
          cvid: card.cvid,
          deck: card.deck,
          front: card.front,
          back: card.back,
          tileType: card.tileType
        });
        continue;
      }

      const cvContent = card.front + "\x1f" + card.back;
      const anContent = an.front + "\x1f" + an.back;
      const sameContent = cvContent === anContent;

      // Move detection — deck drift (silent)
      const currentDeck = deckByNoteId.get(an.ankiId);
      if (currentDeck && currentDeck !== card.deck) {
        plan.moves.push({ cvid: card.cvid, ankiId: an.ankiId, fromDeck: currentDeck, toDeck: card.deck });
      }

      if (sameContent) continue;

      // Last-write-wins
      const cvNewer = (card.mod || 0) >= (an.mod || 0) * 1000;
      if (cvNewer) {
        plan.updated.push({
          direction: "push",
          cvid: card.cvid,
          ankiId: an.ankiId,
          deck: card.deck,
          front: card.front,
          back: card.back,
          oldFront: an.front,
          tileType: card.tileType
        });
      } else {
        plan.updated.push({
          direction: "pull",
          cvid: card.cvid,
          ankiId: an.ankiId,
          front: an.front,
          back: an.back,
          oldFront: card.front,
          tileType: card.tileType,
          writeBack: card.writeBack
        });
      }
    }

    // Deletes — only within this module's namespace (scope already applied
    // when building ankiByCvid). cvids in ankiByCvid that aren't in CV → gone.
    for (const [cvid, an] of ankiByCvid) {
      if (!cvCvids.has(cvid)) {
        plan.deleted.push({ cvid, ankiId: an.ankiId, front: an.front });
      }
    }

    return plan;
  }

  // ============================================================
  // applyPlan — execute the (possibly user-filtered) plan
  // ============================================================
  async function applyPlan(plan, ctx) {
    const url = plan.url;
    const errors = [];

    // Decks (idempotent)
    for (const d of (plan.decksToCreate || [])) {
      try { await invoke(url, "createDeck", { deck: d }); } catch (e) { /* exists is fine */ }
    }

    let added = 0, updated = 0, pulled = 0, deleted = 0, moved = 0;

    // Adds — per-item try/catch so one bad note doesn't abort the rest
    for (const item of (plan.added || [])) {
      try {
        await invoke(url, "addNote", {
          note: {
            deckName: item.deck,
            modelName: "Basic",
            fields: { Front: item.front, Back: item.back },
            tags: ["crashvault", "cvid:" + item.cvid],
            options: { allowDuplicate: true }
          }
        });
        added++;
      } catch (e) {
        errors.push({ op: "add", cvid: item.cvid, message: e.message });
      }
    }

    // Updates (both directions)
    for (const item of (plan.updated || [])) {
      try {
        if (item.direction === "push") {
          await invoke(url, "updateNoteFields", {
            note: { id: item.ankiId, fields: { Front: item.front, Back: item.back } }
          });
          updated++;
        } else {
          // Pull Anki → CV
          item.writeBack(item.front, item.back);
          pulled++;
          if (ctx && ctx.markDirty) ctx.markDirty();
        }
      } catch (e) {
        errors.push({ op: item.direction === "push" ? "update" : "pull", cvid: item.cvid, message: e.message });
      }
    }

    // Deletes — batched (one call deletes many). On failure we lose the whole
    // batch but the next sync re-detects and tries again.
    if ((plan.deleted || []).length) {
      try {
        await invoke(url, "deleteNotes", { notes: plan.deleted.map(d => d.ankiId) });
        deleted = plan.deleted.length;
      } catch (e) {
        errors.push({ op: "delete-batch", message: e.message });
      }
    }

    // Moves — one round-trip per moved note (findCards + changeDeck).
    for (const mv of (plan.moves || [])) {
      try {
        const cardIds = await invoke(url, "findCards", { query: `nid:${mv.ankiId}` });
        if (cardIds.length) {
          await invoke(url, "changeDeck", { cards: cardIds, deck: mv.toDeck });
          moved++;
        }
      } catch (e) {
        errors.push({ op: "move", cvid: mv.cvid, message: e.message });
      }
    }

    // Silent duplicate cleanup — older copies of cards that share a cvid with
    // the canonical note. No user gate; this is purely housekeeping.
    if ((plan.dupeDeletes || []).length) {
      try {
        await invoke(url, "deleteNotes", { notes: plan.dupeDeletes });
      } catch (e) {
        errors.push({ op: "dupe-cleanup", message: e.message });
      }
    }

    return { added, updated, pulled, deleted, moved, errors };
  }

  // Backwards-compat one-shot path (push+pull everything, no dialog).
  async function syncModule(moduleState, config, ctx) {
    const plan = await computePlan(moduleState, config);
    return applyPlan(plan, ctx);
  }

  // ============================================================
  // Test connection
  // ============================================================
  async function test(config) {
    try {
      const version = await invoke(config.url || "http://127.0.0.1:8765", "version", {});
      return { ok: true, message: `Verbunden ✓  (AnkiConnect API v${version})` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // ============================================================
  // Config dialog
  // ============================================================
  const DEFAULT_URL = "http://127.0.0.1:8765";

  function renderConfig(container, config, save) {
    const origin = window.location.origin;
    container.innerHTML = `
      <h3>AnkiConnect konfigurieren</h3>

      <div class="fcfg-field">
        <label>AnkiConnect URL</label>
        <div style="display:flex;gap:8px;">
          <input type="text" data-field="url" value="${escapeAttr(config.url || DEFAULT_URL)}" style="flex:1">
          <button class="small" data-act="default-url">Standard</button>
        </div>
      </div>

      <div class="fcfg-field">
        <label>Deck-Wurzel</label>
        <input type="text" data-field="deckRoot" value="${escapeAttr(config.deckRoot || "CrashVault")}">
        <div class="hint">Alle Decks landen unter dieser Wurzel: <code><span data-deckroot-preview>${escapeText(config.deckRoot || "CrashVault")}</span>::&lt;Modul&gt;::&lt;Tile&gt;::&lt;Thema&gt;</code></div>
      </div>

      <div class="fcfg-field" style="flex-direction:row;align-items:center;gap:10px;">
        <label class="switch">
          <input type="checkbox" data-field="autoSyncOnSave" ${config.autoSyncOnSave ? "checked" : ""}>
          <span class="slider"></span>
        </label>
        <span style="font-size:13px">Automatisch syncen</span>
      </div>

      <div class="fcfg-field" data-confirm-row style="flex-direction:row;align-items:center;gap:10px;${config.autoSyncOnSave ? "display:none;" : ""}">
        <label class="switch">
          <input type="checkbox" data-field="requireConfirm" ${config.requireConfirm ? "checked" : ""}>
          <span class="slider"></span>
        </label>
        <span style="font-size:13px">Änderungen manuell bestätigen</span>
      </div>

      <div class="fcfg-field">
        <label>CORS Config</label>
        <div class="copy-row">
          <code>${escapeText(origin)}</code>
          <button class="small" data-act="copy-origin">Kopieren</button>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:18px;align-items:center;">
        <button data-act="test">Verbindung testen</button>
        <div style="display:flex;gap:8px;">
          <button data-act="cancel">Abbrechen</button>
          <button class="primary" data-act="save">Speichern</button>
        </div>
      </div>
      <div class="fcfg-test-result" data-test-result style="display:none"></div>
    `;

    const get = () => ({
      url: container.querySelector("[data-field='url']").value.trim() || DEFAULT_URL,
      deckRoot: container.querySelector("[data-field='deckRoot']").value.trim() || "CrashVault",
      autoSyncOnSave: container.querySelector("[data-field='autoSyncOnSave']").checked,
      requireConfirm: container.querySelector("[data-field='requireConfirm']").checked
    });

    const autoToggle = container.querySelector("[data-field='autoSyncOnSave']");
    const confirmRow = container.querySelector("[data-confirm-row]");
    autoToggle.addEventListener("change", () => {
      confirmRow.style.display = autoToggle.checked ? "none" : "";
    });

    const deckInput = container.querySelector("[data-field='deckRoot']");
    const deckPreview = container.querySelector("[data-deckroot-preview]");
    deckInput.addEventListener("input", () => {
      deckPreview.textContent = deckInput.value.trim() || "CrashVault";
    });

    container.querySelector("[data-act='default-url']").addEventListener("click", () => {
      container.querySelector("[data-field='url']").value = DEFAULT_URL;
    });
    container.querySelector("[data-act='copy-origin']").addEventListener("click", () => {
      navigator.clipboard.writeText(origin).then(
        () => toast("Origin kopiert ✓", "ok"),
        () => toast("Kopieren fehlgeschlagen", "err")
      );
    });
    container.querySelector("[data-act='test']").addEventListener("click", async () => {
      const result = container.querySelector("[data-test-result]");
      result.style.display = "block";
      result.className = "fcfg-test-result";
      result.textContent = "Teste…";
      const r = await test(get());
      result.className = "fcfg-test-result " + (r.ok ? "ok" : "err");
      result.textContent = r.message;
    });
    container.querySelector("[data-act='save']").addEventListener("click", () => save(get()));
    container.querySelector("[data-act='cancel']").addEventListener("click", () => save(null));
  }

  window.CV_FEATURES = window.CV_FEATURES || {};
  window.CV_FEATURES["anki-connect"] = {
    label: "AnkiConnect",
    icon: "🔌",
    description: "Bidirektionale Karten-Synchronisation mit deinem lokalen Anki. Last-Write-Wins.",
    defaultConfig: {
      url: DEFAULT_URL,
      deckRoot: "CrashVault",
      autoSyncOnSave: true,
      requireConfirm: false
    },
    renderConfig,
    test,
    // Public surface for the module page
    computePlan,
    applyPlan,
    syncModule
  };
})();
