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
//   computePlan(moduleState, config) -> { added, updated, deleted, url, deckRoot, moves }
//     Pure read; no Anki mutations. `updated` items carry a `direction`
//     field ("push" = CV->Anki, "pull" = Anki->CV) so the confirmation
//     dialog can mix both directions in one list.
//   applyPlan(plan, ctx) -> { added, updated, pulled, deleted, moved }
//     Mutates Anki (and CV for pulls). Caller supplies the (possibly
//     user-filtered) plan returned by computePlan.

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
          out.push({
            cvid: `${moduleState.id}/${tile.id}/${s.id}`,
            deck: [deckRoot, moduleState.name, tile.title || "Sprüche"]
              .filter(Boolean).join("::"),
            front: fb.front,
            back: fb.back,
            mod: s.mod || 0,
            tileType: tile.type,
            writeBack: (front, back) => {
              const glue = front.endsWith(",") ? " " : ", ";
              s.text = (front + glue + back).replace(/,\s*,\s*/, ", ");
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

    const decksToCreate = [...new Set(cvCards.map(c => c.deck))];

    // Pull all CV-managed notes from Anki in one query
    const noteIds = await invoke(url, "findNotes", { query: "tag:crashvault" });
    const notes = noteIds.length
      ? await invoke(url, "notesInfo", { notes: noteIds })
      : [];

    // Index by cvid + fetch deck-per-note (needed for move detection)
    const ankiByCvid = new Map();
    for (const note of notes) {
      const tag = (note.tags || []).find(t => t.startsWith("cvid:"));
      if (!tag) continue;
      ankiByCvid.set(tag.substring(5), {
        ankiId: note.noteId,
        front: note.fields?.Front?.value || "",
        back:  note.fields?.Back?.value  || "",
        mod:   note.mod || 0
      });
    }

    // Deck info for all those cards — one batch call
    const ankiCardIds = notes.length
      ? await invoke(url, "findCards", { query: "tag:crashvault" })
      : [];
    let cardInfos = [];
    if (ankiCardIds.length) {
      cardInfos = await invoke(url, "cardsInfo", { cards: ankiCardIds });
    }
    const deckByNoteId = new Map();
    for (const ci of cardInfos) {
      if (!deckByNoteId.has(ci.note)) deckByNoteId.set(ci.note, ci.deckName);
    }

    const plan = {
      url, deckRoot,
      decksToCreate,
      added: [],
      updated: [],   // each: { direction: "push" | "pull", cvid, ... }
      deleted: [],
      moves: []      // applied silently — not user-confirmable
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

    // Deletes — anki has cvid that CV doesn't
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

    // Decks (idempotent)
    for (const d of (plan.decksToCreate || [])) {
      try { await invoke(url, "createDeck", { deck: d }); } catch (e) { /* exists */ }
    }

    let added = 0, updated = 0, pulled = 0, deleted = 0, moved = 0;

    for (const item of (plan.added || [])) {
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
    }

    for (const item of (plan.updated || [])) {
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
    }

    if ((plan.deleted || []).length) {
      await invoke(url, "deleteNotes", { notes: plan.deleted.map(d => d.ankiId) });
      deleted = plan.deleted.length;
    }

    // Moves: collect all ankiIds we want re-decked, then changeDeck per (deck, [cardIds])
    for (const mv of (plan.moves || [])) {
      try {
        const cardIds = await invoke(url, "findCards", { query: `nid:${mv.ankiId}` });
        if (cardIds.length) {
          await invoke(url, "changeDeck", { cards: cardIds, deck: mv.toDeck });
          moved++;
        }
      } catch (e) { /* non-fatal */ }
    }

    return { added, updated, pulled, deleted, moved };
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

    // Reveal/hide the "manuell bestätigen" row in lockstep with the auto toggle.
    const autoToggle = container.querySelector("[data-field='autoSyncOnSave']");
    const confirmRow = container.querySelector("[data-confirm-row]");
    autoToggle.addEventListener("change", () => {
      confirmRow.style.display = autoToggle.checked ? "none" : "";
    });

    // Live deck-root preview
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
    syncModule  // legacy one-shot
  };
})();
