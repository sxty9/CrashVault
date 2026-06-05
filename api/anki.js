// POST /api/anki
// Body: { deckName, deckId?, cards: [{front, back, id?}] }
//   OR: { decks: [{name, id?, cards: [...]}] }   (multi-deck creates subdecks)
// Response: binary .apkg file
//
// Generates an Anki package using sql.js. Stable model/deck/note ids derived
// from caller-supplied seeds, so re-imports update existing notes instead of
// duplicating them.

const crypto = require("crypto");
const initSqlJs = require("sql.js/dist/sql-asm.js");
const JSZip = require("jszip");
const gh = require("./_github.js");
const auth = require("./_auth.js");

let sqlPromise = null;
function getSQL() { if (!sqlPromise) sqlPromise = initSqlJs(); return sqlPromise; }

function guid() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = ""; for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const GUID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-./:;<=>?@[]^_`{|}~";
function stableGuid(id) {
  const hashHex = crypto.createHash("sha1").update(String(id), "utf8").digest("hex");
  let num = BigInt("0x" + hashHex.substring(0, 16));
  const base = BigInt(GUID_ALPHABET.length);
  let out = "";
  while (num > 0n) { out = GUID_ALPHABET[Number(num % base)] + out; num = num / base; }
  while (out.length < 10) out = GUID_ALPHABET[0] + out;
  return out;
}
function stableInt(seed) {
  const hashHex = crypto.createHash("sha1").update(String(seed), "utf8").digest("hex");
  return Number(BigInt("0x" + hashHex.substring(0, 13)));
}
const MODEL_ID = stableInt("crashvault-basic-model-v1");
function fieldChecksum(field) {
  const stripped = field.replace(/<[^>]*>/g, "").trim();
  return parseInt(crypto.createHash("sha1").update(stripped, "utf8").digest("hex").substring(0, 8), 16);
}

function buildApkgDb(SQL, allDecks) {
  const db = new SQL.Database();
  const now = Math.floor(Date.now() / 1000);
  const modelId = MODEL_ID;

  db.run(`CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)`);
  db.run(`CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld text not null, csum integer not null, flags integer not null, data text not null)`);
  db.run(`CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)`);
  db.run(`CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)`);
  db.run(`CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)`);
  db.run(`CREATE INDEX ix_notes_usn ON notes (usn)`);
  db.run(`CREATE INDEX ix_cards_usn ON cards (usn)`);
  db.run(`CREATE INDEX ix_revlog_usn ON revlog (usn)`);
  db.run(`CREATE INDEX ix_cards_nid ON cards (nid)`);
  db.run(`CREATE INDEX ix_cards_sched ON cards (did, queue, due)`);
  db.run(`CREATE INDEX ix_revlog_cid ON revlog (cid)`);
  db.run(`CREATE INDEX ix_notes_csum ON notes (csum)`);

  const model = {
    [modelId]: {
      id: modelId, name: "Basic", type: 0, mod: now, usn: -1, sortf: 0, did: 1,
      tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}", did: null, bqfmt: "", bafmt: "" }],
      flds: [
        { name: "Front", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20, media: [] },
        { name: "Back",  ord: 1, sticky: false, rtl: false, font: "Arial", size: 20, media: [] }
      ],
      css: ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }",
      latexPre: "\\documentclass[12pt]{article}\\n\\special{papersize=3in,5in}\\n\\usepackage[utf8]{inputenc}\\n\\usepackage{amssymb,amsmath}\\n\\pagestyle{empty}\\n\\setlength{\\parindent}{0in}\\n\\begin{document}\\n",
      latexPost: "\\end{document}",
      latexsvg: false, req: [[0, "any", [0]]]
    }
  };

  const decks = {
    1: { id: 1, name: "Default", mod: now, usn: -1, lrnToday: [0,0], revToday: [0,0], newToday: [0,0], timeToday: [0,0], collapsed: false, desc: "", dyn: 0, conf: 1, extendRev: 50, extendNew: 10 }
  };
  allDecks.forEach((d) => {
    const deckId = stableInt(d.id ? "deck:" + d.id : "deckname:" + d.name);
    d._deckId = deckId;
    decks[deckId] = { id: deckId, name: d.name, mod: now, usn: -1, lrnToday: [0,0], revToday: [0,0], newToday: [0,0], timeToday: [0,0], collapsed: false, desc: "", dyn: 0, conf: 1, extendRev: 50, extendNew: 10 };
  });

  const dconf = {
    1: { id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true,
         new: { ints: [1,10,0], initialFactor: 2500, separate: true, order: 1, perDay: 20, delays: [1,10], bury: false },
         rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2, minSpace: 1, fuzz: 0.05 },
         lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 }, dyn: false }
  };
  const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: modelId, nextPos: 1, sortType: "noteFld", sortBackwards: false, addToCur: true };

  db.run(`INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [1, now, now, now * 1000, 11, 0, -1, 0, JSON.stringify(conf), JSON.stringify(model), JSON.stringify(decks), JSON.stringify(dconf), "{}"]);

  let cardPos = 0;
  const baseTime = Date.now();
  const APP_TAG = "crashvault";
  allDecks.forEach(d => {
    (d.cards || []).forEach((card) => {
      const noteId = baseTime + cardPos * 2;
      const cardId = baseTime + cardPos * 2 + 1;
      const front = card.front || "";
      const back = card.back || "";
      const flds = front + "\x1f" + back;
      const noteGuid = card.id ? stableGuid(card.id) : guid();
      db.run(`INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [noteId, noteGuid, modelId, now, -1, " " + APP_TAG + " ", flds, front, fieldChecksum(front), 0, ""]);
      db.run(`INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cardId, noteId, d._deckId, 0, now, -1, 0, 0, cardPos, 0, 0, 0, 0, 0, 0, 0, 0, ""]);
      cardPos++;
    });
  });

  return db.export();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return gh.sendJson(res, 405, { error: "Method not allowed" });
    }
    await auth.requireAuth(req);
    const body = await gh.readJson(req);
    let allDecks;
    if (body.decks && Array.isArray(body.decks)) {
      allDecks = body.decks.filter(d => d.cards && d.cards.length > 0);
    } else if (body.deckName && Array.isArray(body.cards) && body.cards.length > 0) {
      allDecks = [{ id: body.deckId, name: body.deckName, cards: body.cards }];
    } else {
      return gh.sendJson(res, 400, { error: "Keine Karten zum Exportieren" });
    }
    if (!allDecks.length) return gh.sendJson(res, 400, { error: "Keine Karten zum Exportieren" });

    const SQL = await getSQL();
    const dbData = buildApkgDb(SQL, allDecks);

    const zip = new JSZip();
    zip.file("collection.anki2", dbData);
    zip.file("media", "{}");
    const apkg = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    const filename = allDecks.length === 1
      ? (allDecks[0].name.replace(/[^a-zA-Z0-9äöüÄÖÜß\s_-]/g, "").trim() || "deck") + ".apkg"
      : (body.bundleName || "CrashVault-Export") + ".apkg";

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", apkg.length);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(apkg);
  } catch (e) {
    console.error("anki export error:", e);
    return gh.sendError(res, e);
  }
};
