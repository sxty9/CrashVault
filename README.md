# CrashVault

Modulares Lern-Cockpit für Klausurvorbereitung.

- **Dashboard** mit beliebig vielen Modulen (BWL, Rechnernetze, Diskrete Mathematik II, …)
- **Modul-Übersicht** als freier Canvas mit frei platzierbaren, größenveränderbaren Kacheln
- **Kachel-Klassen** (beliebig oft pro Modul instanziierbar):
  - **Themenliste** — Klausurthemen mit Quellenangabe, Notizen, Dateianhängen und Anki-Karteikarten je Thema
  - **Sprücheliste** — Merksätze / „Ludolph-Sprüche" mit Anki-Export (Front/Back-Split)
- **Storage** = direkt im GitHub-Repo (`modules/<id>/data.js` + `modules/<id>/files/…`)
- **Hosting** = Vercel-Serverless-Functions (`/api/*`)
- **Anki .apkg**-Export pro Topic, pro Tile oder gesamtes Modul

## Architektur

```
CrashVault/
├── index.html                  Dashboard (Modul-Übersicht)
├── module.html                 Modul-View (Canvas + Tiles)
├── assets/
│   ├── style.css               Shared Styles
│   └── util.js                 Shared Client-Helpers (api, toast, anki utils)
├── tiles/
│   ├── topic-list.js           Themenliste-Kachelklasse
│   └── spruch-list.js          Sprücheliste-Kachelklasse
├── api/
│   ├── _github.js              GitHub-API-Helpers
│   ├── registry.js             GET/POST registry (Modul-Liste)
│   ├── data.js                 GET/POST per-Modul-Daten
│   ├── upload.js               Binär-Upload für Anhänge
│   ├── file.js                 Datei-Download
│   ├── files.js                Datei-Liste pro Modul
│   └── anki.js                 .apkg-Generator (sql.js + JSZip)
├── modules/
│   ├── registry.js             Modul-Registry (auto-generated)
│   └── <id>/
│       ├── data.js             Modul-State (auto-generated, enthält tiles[])
│       └── files/…             Anhänge dieses Moduls
└── scripts/
    └── migrate-bwl.js          BWL-Repo → CrashVault-Modul
```

### Datenmodell

**Registry** (`modules/registry.js`):

```js
window.CRASHVAULT_REGISTRY = {
  modules: [ { id, name, color, createdAt }, … ]
}
```

**Pro Modul** (`modules/<id>/data.js`):

```js
window.CRASHVAULT_MODULE = {
  id, name,
  tiles: [
    {
      id, type: "topic-list",
      title, x, y, w, h, z,
      state: { topics: [{ id, title, location, notes, attachments, cards }] }
    },
    {
      id, type: "spruch-list",
      title, x, y, w, h, z,
      state: { items: [{ id, text, height }] }
    }
  ]
}
```

Jede Kachelklasse liegt in `tiles/<type>.js` und registriert sich auf
`window.CV_TILES[<type>]` mit `{ label, icon, defaultSize, defaultState,
render(body, tile, ctx) }`. Neue Klassen einfach dazu schreiben — der „+
Kachel"-FAB im Modul listet automatisch alles auf, was in `window.CV_TILES`
registriert ist.

## Setup

### 1. GitHub-Repo anlegen

`gh` ist auf deinem Mac nicht installiert, also bitte einmal manuell:

1. Auf https://github.com/new → Name: **CrashVault** (private oder public,
   beides geht), kein README/`.gitignore`/License anhaken.
2. Lokal pushen:

```bash
cd ~/Code/CrashVault
git add -A
git commit -m "Initial CrashVault scaffold + BWL-Migration"
git remote add origin git@github.com:<DEIN_USERNAME>/CrashVault.git
git branch -M main
git push -u origin main
```

### 2. Vercel-Projekt verknüpfen

1. https://vercel.com/new → wähle das frisch gepushte CrashVault-Repo.
2. Framework Preset: **Other**. Build/Output-Settings unverändert lassen.
3. **Environment Variables** anlegen:
   - `GITHUB_TOKEN` — Personal Access Token mit `repo`-Scope (am besten ein
     fine-grained Token, nur Zugriff auf das CrashVault-Repo, Permissions:
     Contents = Read+Write).
   - `GITHUB_OWNER` — dein GitHub-Username (oder Org-Name).
   - `GITHUB_REPO` — `CrashVault`.
   - `GITHUB_BRANCH` — `main`.
4. Deploy. Die App ist unter der Vercel-URL erreichbar; das Dashboard zeigt
   sofort das migrierte BWL-Modul.

### 3. BWL-Migration

Schon erledigt durch `scripts/migrate-bwl.js`. Falls du sie nochmal frisch
durchspielen willst (das überschreibt `modules/bwl/`):

```bash
node scripts/migrate-bwl.js "/Users/henry/Library/CloudStorage/OneDrive-NORDAKADEMIE/Sem1+2 BWL Klausurvorbereitung"
```

Das Skript

- liest `klausur-data.js` aus dem BWL-Repo (read-only, nichts wird dort geändert),
- erzeugt `modules/bwl/data.js` mit zwei Kachel-Instanzen (Themenliste +
  Sprücheliste),
- kopiert alle referenzierten Anhänge nach `modules/bwl/files/` und schreibt
  die Pfade im State um,
- trägt BWL in `modules/registry.js` ein.

## Lokal entwickeln

```bash
npm i -g vercel
vercel dev
```

Vercel-CLI startet einen lokalen Server mit Serverless-Functions. Vorher in
`.env` (oder via `vercel env pull`) die o.g. `GITHUB_*`-Variablen setzen.

## Was bewusst NICHT portiert wurde (gegenüber der BWL-App)

Folgende Polish-Features aus der BWL-Version habe ich bewusst weggelassen,
um die erste CrashVault-Version übersichtlich zu halten. Falls du sie
brauchst, sind sie alle einzeln gut nachholbar (Code in der BWL-Repo unter
`index.html` zur Referenz):

- **Pro-Student-Anki-Status** (per-Browser-Identität, Export-Awareness, dass
  Karten in *deinem* Anki landeten).
- **Sync-Banner / Tombstones** („Diese Karten musst du noch in Anki
  löschen") inkl. Cleanup-`.apkg`.
- **Versions-History / Rollback** auf einen früheren Commit.

Die Kerndaten und der reguläre Speicher-/Lade-Pfad (inkl. optimistic
locking via SHA) sind dagegen 1:1 übernommen.
