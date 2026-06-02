// Tile class: spruch-list  (Sprücheliste / Ludolph-style)
//
// State shape (per tile instance):
//   { items: [{ id, text, height? }] }
//
// Each item is one Spruch. On Anki export the text is split into front/back at
// the comma (or word boundary) closest to the middle — same logic as BWL.

(function () {
  "use strict";

  const { uid, escapeText, toast, autosize, splitSpruch, downloadApkg } = window.CV;

  function defaultState() { return { items: [] }; }

  function render(body, tile, ctx) {
    if (!tile.state || !Array.isArray(tile.state.items)) tile.state = defaultState();
    tile.state.items.forEach(s => { if (!s.id) s.id = uid(); });

    body.innerHTML = `
      <div class="ludolph" data-list></div>
      <div class="footer-actions">
        <button class="small" data-act="export">Anki Export</button>
      </div>
      <div class="add-row">
        <button class="primary" data-act="add" style="width:100%">+ Spruch</button>
      </div>
    `;

    renderList(body, tile, ctx);
    body.querySelector("[data-act='add']").addEventListener("click", () => {
      tile.state.items.push({ id: uid(), text: "", mod: Date.now() });
      ctx.markDirty(); renderList(body, tile, ctx);
      const tas = body.querySelectorAll("textarea");
      if (tas.length) tas[tas.length - 1].focus();
    });
    body.querySelector("[data-act='export']").addEventListener("click", () => exportItems(tile, ctx));
  }

  function renderList(body, tile, ctx) {
    const list = body.querySelector("[data-list]");
    list.innerHTML = "";
    if (!tile.state.items.length) {
      list.innerHTML = `<div class="empty">Noch keine Sprüche.</div>`;
      return;
    }
    tile.state.items.forEach((s, idx) => {
      const el = document.createElement("div");
      el.className = "spruch";
      el.innerHTML = `
        <span class="num">${idx + 1}.</span>
        <textarea placeholder="Spruch eingeben…">${escapeText(s.text || "")}</textarea>
        <button class="rm" title="Entfernen">✕</button>
      `;
      const ta = el.querySelector("textarea");
      if (s.height) ta.style.height = s.height;
      else autosize(ta);
      ta.addEventListener("input", e => { s.text = e.target.value; s.mod = Date.now(); autosize(ta); ctx.markDirty(); });
      ta.addEventListener("pointerup", () => {
        const h = ta.style.height;
        if (h && h !== s.height) { s.height = h; ctx.markDirty(); }
      });
      el.querySelector(".rm").addEventListener("click", () => {
        tile.state.items.splice(idx, 1);
        ctx.markDirty(); renderList(body, tile, ctx);
      });
      list.appendChild(el);
    });
  }

  async function exportItems(tile, ctx) {
    const items = (tile.state.items || []).filter(s => s.text && s.text.trim());
    if (!items.length) { toast("Keine Sprüche zum Exportieren", "warn"); return; }
    const cards = items.map(s => {
      const fb = splitSpruch(s.text);
      return fb ? { id: "spruch:" + tile.id + ":" + s.id, front: fb.front, back: fb.back } : null;
    }).filter(Boolean);
    if (!cards.length) { toast("Keine Sprüche zum Exportieren", "warn"); return; }
    const tileTitle = tile.title || "Sprüche";
    await downloadApkg({
      deckId: "spruch-list:" + tile.id,
      deckName: `${ctx.moduleName} - ${tileTitle}`,
      cards
    });
  }

  window.CV_TILES = window.CV_TILES || {};
  window.CV_TILES["spruch-list"] = {
    label: "Sprücheliste",
    icon: "💬",
    description: "Liste von Sprüchen / Merksätzen mit Anki-Export (Front/Back-Split).",
    defaultSize: { w: 440, h: 620 },
    defaultState,
    render
  };
})();
