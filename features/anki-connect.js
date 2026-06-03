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

  // Glue-aware rejoin for spruch front+back: if the front already ends with a
  // comma (typical when splitSpruch placed the split AFTER a comma), join with
  // a single space; otherwise add ", ". Ensures we never produce ",, ".
  function joinSpruch(front, back) {
    const f = String(front || "");
    const b = String(back  || "");
    const glue = f.endsWith(",") ? " " : ", ";
    return (f + glue + b).trim();
  }

  // ============================================================
  // Collect every "syncable card" from a module's tiles
  // ============================================================
  // Note on spruch: CV's splitSpruch is the authoritative split. We compare
  // CV's split output literally against Anki's stored field values. If a user
  // edits Anki to a different split (e.g. removes the trailing comma on
  // front), the pull rejoins their content into s.text, the next collectCards
  // re-runs splitSpruch, and the resulting CV-canonical split gets pushed
  // back to Anki — which is exactly the round-trip semantic the user asked
  // for.
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
            // Pull rejoins front+back so the next collectCards' splitSpruch
            // produces CV's canonical split — which then gets pushed to Anki
            // on the follow-up sync, making CV authoritative.
            writeBack: (newFront, newBack) => {
              s.text = joinSpruch(newFront, newBack);
              s.mod = Date.now();
            }
          });
        }
      }
    }
    return out;
  }

  // ============================================================
  // Resolve a deck name back to a CV tile (and topic, for topic-list tiles).
  // Deck names produced by collectCards have the shape
  //   <deckRoot>::<moduleName>::<tileTitle>[::<topicTitle>]
  // so the reverse parse just splits on "::" and matches by exact title.
  // Returns null if the deck doesn't belong to this module or no matching
  // tile/topic exists — those are silently skipped on import.
  // ============================================================
  function findImportTarget(moduleState, deckName, deckRoot) {
    const segments = (deckName || "").split("::");
    if (segments[0] !== deckRoot) return null;
    if (segments[1] !== moduleState.name) return null;
    const tileTitle = segments[2];
    if (!tileTitle) return null;
    const tile = (moduleState.tiles || []).find(t => (t.title || "") === tileTitle);
    if (!tile) return null;
    if (tile.type === "topic-list") {
      const topicTitle = segments[3];
      if (!topicTitle) return null;
      const topic = (tile.state?.topics || []).find(x => (x.title || "") === topicTitle);
      if (!topic) return null;
      return { type: "topic-list", tile, topic };
    }
    if (tile.type === "spruch-list") {
      if (segments.length !== 3) return null;
      return { type: "spruch-list", tile };
    }
    return null;
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

    // Find all notes that could be relevant:
    //   1. Anything tagged "crashvault" (managed) — across all modules
    //   2. Anything sitting in our module's deck subtree (potential imports)
    // Notes in (2) but not (1) are user-created in Anki and need to be pulled
    // into CV. We fetch deckNames first because Anki search has no clean
    // "match all sub-decks" syntax — we OR the explicit deck names instead.
    const allManagedIds = await invoke(url, "findNotes", { query: "tag:crashvault" });

    const myModuleRoot = `${deckRoot}::${moduleState.name}`;
    let importCandidateIds = [];
    let myDeckQuery = "";
    try {
      const allDeckNames = await invoke(url, "deckNames", {});
      const myDecks = (allDeckNames || []).filter(d =>
        d === myModuleRoot || d.startsWith(myModuleRoot + "::")
      );
      if (myDecks.length) {
        myDeckQuery = myDecks.map(d => `"deck:${d}"`).join(" OR ");
        importCandidateIds = await invoke(url, "findNotes", { query: myDeckQuery });
      }
    } catch (e) { /* deckNames not available → no imports detected this run */ }

    const combinedIds = [...new Set([...allManagedIds, ...importCandidateIds])];
    const allNotes = combinedIds.length
      ? await invoke(url, "notesInfo", { notes: combinedIds })
      : [];

    // Deck name per note id — fetch cards in our module's decks once. We need
    // this for both move detection (managed) and import target resolution
    // (unmanaged). Cards from other modules aren't here, which is what we want.
    let deckByNoteId = new Map();
    if (myDeckQuery) {
      try {
        const ankiCardIds = await invoke(url, "findCards", { query: myDeckQuery });
        if (ankiCardIds.length) {
          const cardInfos = await invoke(url, "cardsInfo", { cards: ankiCardIds });
          for (const ci of cardInfos) {
            if (!deckByNoteId.has(ci.note)) deckByNoteId.set(ci.note, ci.deckName);
          }
        }
      } catch (e) { /* non-fatal */ }
    }

    // Group managed notes (cvid-tagged) by cvid, picking canonical (highest
    // mod); the others are stray duplicates that get silent-cleaned at apply.
    const allByCvid = new Map(); // cvid → note[]
    const importCandidates = []; // notes with no cvid tag — candidates for pull-import
    for (const note of allNotes) {
      const tag = (note.tags || []).find(t => t.startsWith("cvid:"));
      if (tag) {
        const cvid = tag.substring(5);
        if (!allByCvid.has(cvid)) allByCvid.set(cvid, []);
        allByCvid.get(cvid).push(note);
      } else {
        // Unmanaged — possibly Anki-side new card we should import
        importCandidates.push(note);
      }
    }

    // Scope managed to this module + collect duplicate-cleanup work
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

    const plan = {
      url, deckRoot,
      decksToCreate,
      added: [],     // direction "push" (CV→Anki addNote) or "pull" (Anki→CV import)
      updated: [],   // direction "push" or "pull"
      deleted: [],
      moves: [],     // silent — not user-confirmable
      dupeDeletes    // silent cleanup of stray Anki notes with same cvid
    };

    const cvCvids = new Set(cvCards.map(c => c.cvid));

    // Import discovery: unmanaged notes in our module's deck tree become
    // pull-direction added items. We build the cvid for the new CV card now
    // so applyPlan can both insert the card and tag the Anki note in one go.
    for (const note of importCandidates) {
      const deck = deckByNoteId.get(note.noteId);
      if (!deck) continue; // no deck info (shouldn't happen) → skip
      const target = findImportTarget(moduleState, deck, deckRoot);
      if (!target) continue; // not addressable in this module — skip silently
      const ankiFront = note.fields?.Front?.value || "";
      const ankiBack  = note.fields?.Back?.value  || "";
      const newCardId = window.CV.uid();
      let cvid;
      let applyImport;
      if (target.type === "topic-list") {
        cvid = `${moduleState.id}/${target.tile.id}/${target.topic.id}/${newCardId}`;
        applyImport = () => {
          target.topic.cards = target.topic.cards || [];
          target.topic.cards.push({
            id: newCardId,
            front: ankiFront,
            back: ankiBack,
            mod: Date.now()
          });
        };
      } else {
        cvid = `${moduleState.id}/${target.tile.id}/${newCardId}`;
        applyImport = () => {
          target.tile.state = target.tile.state || {};
          target.tile.state.items = target.tile.state.items || [];
          target.tile.state.items.push({
            id: newCardId,
            text: joinSpruch(ankiFront, ankiBack),
            mod: Date.now()
          });
        };
      }
      plan.added.push({
        direction: "pull",
        cvid,
        ankiId: note.noteId,
        deck,
        front: ankiFront,
        back:  ankiBack,
        tileType: target.type,
        applyImport
      });
    }

    for (const card of cvCards) {
      const an = ankiByCvid.get(card.cvid);
      if (!an) {
        plan.added.push({
          direction: "push",
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

    let added = 0, imported = 0, updated = 0, pulled = 0, deleted = 0, moved = 0;

    // Adds — per-item try/catch so one bad note doesn't abort the rest.
    // Two directions:
    //   push: CV → Anki, create a new Anki note with the cvid tag
    //   pull: Anki → CV, insert the new card into CV state and tag the
    //         existing Anki note as managed (addTags writes a new cvid)
    for (const item of (plan.added || [])) {
      try {
        if (item.direction === "pull") {
          item.applyImport();
          await invoke(url, "addTags", {
            notes: [item.ankiId],
            tags: "crashvault cvid:" + item.cvid
          });
          imported++;
          if (ctx && ctx.markDirty) ctx.markDirty();
        } else {
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
      } catch (e) {
        errors.push({
          op: item.direction === "pull" ? "import" : "add",
          cvid: item.cvid,
          message: e.message
        });
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

    return { added, imported, updated, pulled, deleted, moved, errors };
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
