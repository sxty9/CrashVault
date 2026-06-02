// Tile class: topic-list  (Themenliste)
//
// State shape (per tile instance):
//   { topics: [{ id, title, location, notes, attachments: [{id,name,path,source}], cards: [{id,front,back}], notesHeight? }] }
//
// Wiring contract: render(body, tile, ctx) where ctx provides:
//   moduleId        — current module id (for file paths + Anki deck names)
//   moduleName      — for Anki deck names
//   markDirty()     — invalidate save state and persist cache
//   uploadQueue     — Map<attachmentId, File> shared with the save flow
//   repoFiles       — array of { path, name } available for re-attaching
//   openAnki(tile, topic)  — open the per-topic Anki dialog

(function () {
  "use strict";

  const { $, uid, escapeText, escapeAttr, toast, ankiCardKey, downloadApkg } = window.CV;

  function defaultState() { return { topics: [] }; }

  function ensureIds(state) {
    (state.topics || []).forEach(t => {
      if (!t.id) t.id = uid();
      if (!Array.isArray(t.attachments)) t.attachments = [];
      t.attachments.forEach(a => { if (!a.id) a.id = uid(); });
      if (!Array.isArray(t.cards)) t.cards = [];
      t.cards.forEach(c => { if (!c.id) c.id = uid(); });
    });
  }

  function render(body, tile, ctx) {
    if (!tile.state || !Array.isArray(tile.state.topics)) tile.state = defaultState();
    ensureIds(tile.state);

    body.innerHTML = `
      <div class="topics" data-topics></div>
      <div class="footer-actions">
        <button class="small" data-act="export-all" title="Alle Karten dieses Themen-Tiles als .apkg">Alle Karteikarten exportieren</button>
      </div>
      <div class="add-row">
        <input type="text" placeholder="Neues Thema…" data-new-topic>
        <button class="primary" data-act="add">+ Thema</button>
      </div>
    `;
    renderTopics(body, tile, ctx);

    body.querySelector("[data-act='add']").addEventListener("click", () => addFromInput(body, tile, ctx));
    body.querySelector("[data-new-topic]").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); addFromInput(body, tile, ctx); }
    });
    body.querySelector("[data-act='export-all']").addEventListener("click", () => exportAll(tile, ctx));
  }

  function addFromInput(body, tile, ctx) {
    const input = body.querySelector("[data-new-topic]");
    const title = input.value.trim();
    if (!title) return;
    tile.state.topics.push({ id: uid(), title, location: "", notes: "", attachments: [], cards: [] });
    input.value = "";
    ctx.markDirty();
    renderTopics(body, tile, ctx);
  }

  function renderTopics(body, tile, ctx) {
    const wrap = body.querySelector("[data-topics]");
    wrap.innerHTML = "";
    if (!tile.state.topics.length) {
      wrap.innerHTML = `<div class="empty">Noch keine Themen.</div>`;
      return;
    }
    tile.state.topics.forEach((t, idx) => {
      const el = document.createElement("div");
      el.className = "topic";
      el.dataset.id = t.id;
      const cardCount = (t.cards || []).length;
      el.innerHTML = `
        <div class="row">
          <span class="drag" title="Ziehen zum Sortieren">⋮⋮</span>
          <input class="t-title" type="text" value="${escapeAttr(t.title)}" placeholder="Thema…">
          <input class="t-loc" type="text" value="${escapeAttr(t.location || "")}" placeholder="Quelle / Fundstelle">
          <div class="actions">
            <button class="small ghost" data-act="anki" title="Anki Karteikarten">🗂 <span class="anki-badge ${cardCount ? "" : "is-empty"}">${cardCount}</span></button>
            <button class="small ghost" data-act="up" title="Hoch">↑</button>
            <button class="small ghost" data-act="down" title="Runter">↓</button>
            <button class="small danger" data-act="del" title="Löschen">✕</button>
          </div>
        </div>
        <textarea class="notes" placeholder="Notizen, Stichpunkte, Formeln…">${escapeText(t.notes || "")}</textarea>
        <div class="attachments" data-attachments></div>
      `;
      el.querySelector("input.t-title").addEventListener("input", e => { t.title = e.target.value; ctx.markDirty(); });
      el.querySelector("input.t-loc").addEventListener("input",   e => { t.location = e.target.value; ctx.markDirty(); });
      const notesEl = el.querySelector("textarea.notes");
      if (t.notesHeight) notesEl.style.height = t.notesHeight;
      notesEl.addEventListener("input", e => { t.notes = e.target.value; ctx.markDirty(); });
      notesEl.addEventListener("pointerup", () => {
        const h = notesEl.style.height;
        if (h && h !== t.notesHeight) { t.notesHeight = h; ctx.markDirty(); }
      });
      el.querySelector("[data-act='del']").addEventListener("click", () => {
        if (!confirm(`Thema "${t.title}" wirklich löschen?`)) return;
        t.attachments.forEach(a => ctx.uploadQueue.delete(a.id));
        tile.state.topics.splice(idx, 1);
        ctx.markDirty(); renderTopics(body, tile, ctx);
      });
      el.querySelector("[data-act='up']").addEventListener("click", () => moveTopic(body, tile, ctx, idx, -1));
      el.querySelector("[data-act='down']").addEventListener("click", () => moveTopic(body, tile, ctx, idx, +1));
      el.querySelector("[data-act='anki']").addEventListener("click", () => ctx.openAnki(tile, t));

      const drag = el.querySelector(".drag");
      drag.addEventListener("mousedown", () => { el.draggable = true; });
      el.addEventListener("dragstart", e => {
        e.stopPropagation();
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
        el.style.opacity = ".5";
      });
      el.addEventListener("dragend", () => { el.style.opacity = "1"; el.draggable = false; });
      el.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      el.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation();
        const fromId = e.dataTransfer.getData("text/plain");
        if (!fromId || fromId === t.id) return;
        const fromIdx = tile.state.topics.findIndex(x => x.id === fromId);
        const toIdx   = tile.state.topics.findIndex(x => x.id === t.id);
        if (fromIdx < 0 || toIdx < 0) return;
        const [item] = tile.state.topics.splice(fromIdx, 1);
        tile.state.topics.splice(toIdx, 0, item);
        ctx.markDirty(); renderTopics(body, tile, ctx);
      });

      renderAttachments(el.querySelector("[data-attachments]"), tile, t, ctx, body);
      wrap.appendChild(el);
    });
  }

  function moveTopic(body, tile, ctx, idx, delta) {
    const to = idx + delta;
    if (to < 0 || to >= tile.state.topics.length) return;
    const [item] = tile.state.topics.splice(idx, 1);
    tile.state.topics.splice(to, 0, item);
    ctx.markDirty(); renderTopics(body, tile, ctx);
  }

  function renderAttachments(container, tile, topic, ctx, body) {
    container.innerHTML = "";
    topic.attachments.forEach(att => {
      const isPending = ctx.uploadQueue.has(att.id);
      const chip = document.createElement("span");
      chip.className = "attachment" + (isPending ? " pending" : "");
      chip.innerHTML = `
        <a class="name" title="${escapeAttr(att.path || att.name)}">${escapeText(att.name)}</a>
        <span class="src">${isPending ? "ungespeichert" : "Repo"}</span>
        <button class="rm" title="Entfernen">×</button>
      `;
      chip.querySelector(".name").addEventListener("click", () => openAttachment(att, ctx));
      chip.querySelector(".rm").addEventListener("click", () => {
        ctx.uploadQueue.delete(att.id);
        topic.attachments = topic.attachments.filter(a => a.id !== att.id);
        ctx.markDirty(); renderAttachments(container, tile, topic, ctx, body);
      });
      container.appendChild(chip);
    });

    const wrap = document.createElement("span");
    wrap.className = "attach-menu";
    wrap.innerHTML = `<button class="small">+ Datei</button>`;
    wrap.querySelector("button").addEventListener("click", e => {
      e.stopPropagation();
      openAttachMenu(wrap, tile, topic, ctx, () => renderAttachments(container, tile, topic, ctx, body));
    });
    container.appendChild(wrap);
  }

  function openAttachMenu(anchor, tile, topic, ctx, onChange) {
    document.querySelectorAll(".attach-menu-popup").forEach(m => m.remove());
    const menu = document.createElement("div");
    menu.className = "attach-menu-popup";

    const localBtn = document.createElement("button");
    localBtn.textContent = "📤 Lokale Datei hochladen…";
    localBtn.addEventListener("click", () => { menu.remove(); uploadLocalFile(tile, topic, ctx, onChange); });
    menu.appendChild(localBtn);

    if (ctx.repoFiles && ctx.repoFiles.length) {
      const lbl = document.createElement("div");
      lbl.className = "label"; lbl.textContent = "Bereits im Modul";
      menu.appendChild(lbl);
      ctx.repoFiles.forEach(rf => {
        const b = document.createElement("button");
        b.textContent = "📄 " + (rf.name || rf.path.split("/").pop());
        b.addEventListener("click", () => {
          menu.remove();
          if (topic.attachments.some(a => a.path === rf.path)) { toast("Datei ist bereits angehängt", "warn"); return; }
          topic.attachments.push({ id: uid(), name: rf.path.split("/").pop(), path: rf.path, source: "repo" });
          ctx.markDirty(); onChange();
        });
        menu.appendChild(b);
      });
    }

    document.body.appendChild(menu);
    function position() {
      const rect = anchor.getBoundingClientRect();
      const menuH = menu.offsetHeight;
      const menuW = menu.offsetWidth;
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = (spaceBelow >= menuH || spaceBelow >= 120) ? rect.bottom + 4 : rect.top - menuH - 4;
      menu.style.top  = Math.max(8, top) + "px";
      menu.style.left = Math.min(rect.left, window.innerWidth - menuW - 8) + "px";
    }
    position();
    window.addEventListener("scroll", position, { passive: true, capture: true });
    setTimeout(() => {
      const close = e => {
        if (!menu.contains(e.target) && e.target !== anchor) {
          menu.remove();
          window.removeEventListener("scroll", position, { capture: true });
          document.removeEventListener("click", close);
        }
      };
      document.addEventListener("click", close);
    }, 0);
  }

  function uploadLocalFile(tile, topic, ctx, onChange) {
    let picker = $("#filePicker");
    if (!picker) {
      picker = document.createElement("input");
      picker.type = "file"; picker.id = "filePicker"; picker.style.display = "none";
      document.body.appendChild(picker);
    }
    picker.value = "";
    picker.onchange = () => {
      const file = picker.files[0];
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) { toast("Datei > 50 MB — zu groß", "err"); return; }
      const id = uid();
      const path = `modules/${ctx.moduleId}/files/${file.name}`;
      topic.attachments.push({ id, name: file.name, path, source: "local-pending" });
      ctx.uploadQueue.set(id, file);
      ctx.markDirty(); onChange();
      toast("Wird beim Speichern hochgeladen", "warn");
    };
    picker.click();
  }

  function openAttachment(att, ctx) {
    if (ctx.uploadQueue.has(att.id)) {
      const file = ctx.uploadQueue.get(att.id);
      const url = URL.createObjectURL(file);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    if (att.path) window.open(`/api/file?path=${encodeURIComponent(att.path)}`, "_blank");
  }

  async function exportAll(tile, ctx) {
    const decks = (tile.state.topics || [])
      .filter(t => t.cards && t.cards.length && t.cards.some(c => c.front && c.front.trim()))
      .map(t => ({
        id: "topic:" + tile.id + ":" + t.id,
        name: `${ctx.moduleName}::${t.title || "Unbenannt"}`,
        cards: t.cards
          .filter(c => c.front && c.front.trim())
          .map(c => ({ id: ankiCardKey(tile.id, t.id, c.id), front: c.front, back: c.back || "" }))
      }));
    if (!decks.length) { toast("Keine Karteikarten in keinem Thema vorhanden", "warn"); return; }
    await downloadApkg({ decks, bundleName: `${ctx.moduleName}-Alle` });
  }

  // Module-level Anki export helper, exposed so the module page can re-export a
  // single topic from outside this tile (when reopening the Anki dialog).
  async function exportTopic(tile, topic, ctx) {
    const cards = (topic.cards || [])
      .filter(c => c.front && c.front.trim())
      .map(c => ({ id: ankiCardKey(tile.id, topic.id, c.id), front: c.front, back: c.back || "" }));
    if (!cards.length) { toast("Keine Karten mit Inhalt", "warn"); return; }
    await downloadApkg({
      deckId: "topic:" + tile.id + ":" + topic.id,
      deckName: `${ctx.moduleName} - ${topic.title || "Unbenannt"}`,
      cards
    });
  }

  window.CV_TILES = window.CV_TILES || {};
  window.CV_TILES["topic-list"] = {
    label: "Themenliste",
    icon: "📚",
    description: "Klausurthemen mit Notizen, Anhängen und Anki-Karten je Thema.",
    defaultSize: { w: 740, h: 620 },
    defaultState,
    render,
    // Module page calls these helpers from outside the tile (e.g. Anki dialog)
    exportTopic,
    ensureIds
  };
})();
