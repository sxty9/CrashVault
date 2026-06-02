// Feature: AnkiConnect
//
// Bidirectional sync between a CrashVault module and the user's local Anki via
// the AnkiConnect add-on (HTTP API on http://127.0.0.1:8765).
//
// Identity model:
//   Every CrashVault-managed Anki note carries two tags:
//     - "crashvault"                    (so we can find them all in one query)
//     - "cvid:<module/tile/parent/card>" (so we can correlate them back to a CV card)
//   No localStorage mapping is needed — the tag IS the mapping, and it
//   survives device changes, Anki re-syncs, and CrashVault clones.
//
// Conflict resolution: last-write-wins by mod timestamp.
//   CrashVault `card.mod` is set in ms (Date.now()) on every edit.
//   Anki note `mod` is seconds since epoch; we compare `cvMod` vs `anMod * 1000`.
//   If CV's timestamp is newer-or-equal → push. Otherwise → pull.
//   Cards without a CV mod (legacy / migration data) are treated as mod=0, so
//   any later Anki edit wins. That's intentional: an unedited migration card
//   shouldn't overwrite a fresh Anki edit.
//
// Deletion semantics:
//   - Card removed in CV (cvid no longer present): we delete the Anki note.
//   - Card removed in Anki: not supported in v1 yet — the next sync would
//     simply re-add it (because we use tag-based identity, not a local
//     "ever seen" set). Documented in the feature description.

(function () {
  "use strict";

  const { escapeText, escapeAttr, toast, saveFeatureState } = window.CV;

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
            // A Spruch is a single text field — pulling back from Anki means
            // rejoining the front+back. We use ", " if the original split was at
            // a comma; otherwise a single space. The split logic is idempotent
            // so the next push will produce the same front/back.
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
  // syncModule — the heart
  // ============================================================
  async function syncModule(moduleState, config, ctx) {
    const url = config.url || "http://127.0.0.1:8765";
    const deckRoot = config.deckRoot || "CrashVault";
    const cvCards = collectCards(moduleState, deckRoot);

    // 1) Ensure all target decks exist. createDeck is idempotent.
    const decks = [...new Set(cvCards.map(c => c.deck))];
    for (const d of decks) {
      try { await invoke(url, "createDeck", { deck: d }); } catch (e) { /* already exists is fine */ }
    }

    // 2) Pull every CrashVault-managed Anki note (tagged "crashvault") in one shot.
    const noteIds = await invoke(url, "findNotes", { query: "tag:crashvault" });
    const notes = noteIds.length
      ? await invoke(url, "notesInfo", { notes: noteIds })
      : [];

    // Build cvid → anki note index
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

    let added = 0, updated = 0, pulled = 0, deleted = 0, moved = 0;
    const cvCvids = new Set(cvCards.map(c => c.cvid));

    for (const card of cvCards) {
      const an = ankiByCvid.get(card.cvid);
      if (!an) {
        // CV has it, Anki doesn't → add to Anki
        await invoke(url, "addNote", {
          note: {
            deckName: card.deck,
            modelName: "Basic",
            fields: { Front: card.front, Back: card.back },
            tags: ["crashvault", "cvid:" + card.cvid],
            options: { allowDuplicate: true }  // we manage identity via tag, not field-hash
          }
        });
        added++;
        continue;
      }

      const cvContent = card.front + "\x1f" + card.back;
      const anContent = an.front + "\x1f" + an.back;
      const sameContent = cvContent === anContent;

      // Move the underlying card to the right deck whenever it drifted
      // (e.g. user renamed the topic → deck name changed → cards must follow).
      // Cheap and idempotent; skip if no notes are syncing at all.
      try {
        const ankiCardIds = await invoke(url, "findCards", { query: `nid:${an.ankiId}` });
        if (ankiCardIds.length) {
          const info = await invoke(url, "cardsInfo", { cards: ankiCardIds });
          const wrongDeck = info.some(c => c.deckName !== card.deck);
          if (wrongDeck) {
            await invoke(url, "changeDeck", { cards: ankiCardIds, deck: card.deck });
            moved++;
          }
        }
      } catch (e) { /* non-fatal */ }

      if (sameContent) continue;

      // Diff exists → last-write-wins
      const cvNewer = (card.mod || 0) >= (an.mod || 0) * 1000;
      if (cvNewer) {
        await invoke(url, "updateNoteFields", {
          note: { id: an.ankiId, fields: { Front: card.front, Back: card.back } }
        });
        updated++;
      } else {
        // Pull Anki → CV
        card.writeBack(an.front, an.back);
        pulled++;
        ctx.markDirty();
      }
    }

    // 3) Cards that existed in Anki (carrying our cvid:) but are gone in CV → delete
    const toDelete = [];
    for (const [cvid, an] of ankiByCvid) {
      if (!cvCvids.has(cvid)) toDelete.push(an.ankiId);
    }
    if (toDelete.length) {
      await invoke(url, "deleteNotes", { notes: toDelete });
      deleted = toDelete.length;
    }

    return { added, updated, pulled, deleted, moved };
  }

  // ============================================================
  // Test connection (used by the config dialog)
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
  // Config dialog UI
  // ============================================================
  function renderConfig(container, config, save) {
    const origin = window.location.origin;
    container.innerHTML = `
      <h3>AnkiConnect konfigurieren</h3>
      <p class="dlg-sub">Direkter Sync zu deinem lokalen Anki. Funktioniert nur wenn Anki Desktop läuft.</p>

      <div class="fcfg-field">
        <label>AnkiConnect URL</label>
        <input type="text" data-field="url" value="${escapeAttr(config.url || "http://127.0.0.1:8765")}">
        <div class="hint">Default ist gut. Nur ändern, wenn du AnkiConnect auf einem anderen Port betreibst.</div>
      </div>

      <div class="fcfg-field">
        <label>Deck-Wurzel</label>
        <input type="text" data-field="deckRoot" value="${escapeAttr(config.deckRoot || "CrashVault")}">
        <div class="hint">Alle Decks landen unter dieser Wurzel: <code>${escapeText(config.deckRoot || "CrashVault")}::&lt;Modul&gt;::&lt;Tile&gt;::&lt;Thema&gt;</code></div>
      </div>

      <div class="fcfg-field" style="flex-direction:row;align-items:center;gap:10px;">
        <label class="switch">
          <input type="checkbox" data-field="autoSyncOnSave" ${config.autoSyncOnSave ? "checked" : ""}>
          <span class="slider"></span>
        </label>
        <span style="font-size:13px">Nach jedem Speichern automatisch syncen</span>
      </div>

      <div class="fcfg-field">
        <label>CORS — diese Origin in AnkiConnect zulassen</label>
        <div class="copy-row">
          <code data-cv-origin>${escapeText(origin)}</code>
          <button class="small" data-act="copy-origin">Kopieren</button>
        </div>
        <div class="hint">
          In Anki: <b>Tools → Add-ons → AnkiConnect → Config</b>. Trage diese Origin in <code>webCorsOriginList</code> ein:
          <br><code>"webCorsOriginList": ["http://localhost", "${escapeText(origin)}"]</code>
          <br>Anki neu starten danach.
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
      url: container.querySelector("[data-field='url']").value.trim() || "http://127.0.0.1:8765",
      deckRoot: container.querySelector("[data-field='deckRoot']").value.trim() || "CrashVault",
      autoSyncOnSave: container.querySelector("[data-field='autoSyncOnSave']").checked
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
      url: "http://127.0.0.1:8765",
      deckRoot: "CrashVault",
      autoSyncOnSave: true
    },
    renderConfig,
    test,
    syncModule
  };
})();
