# CrashVault

Modulares Lern-Cockpit für Klausurvorbereitung.

- **Dashboard** mit beliebig vielen Modulen (BWL, Rechnernetze, Diskrete Mathematik II, …)
- **Modul-Übersicht** als freier Canvas mit frei platzierbaren, größenveränderbaren Kacheln
- **Kachel-Klassen** (beliebig oft pro Modul instanziierbar):
  - **Themenliste** — Klausurthemen mit Quellenangabe, Notizen, Dateianhängen und Anki-Karteikarten je Thema
  - **Sprücheliste** — Merksätze / „Ludolph-Sprüche" mit Anki-Export (Front/Back-Split)
- **Accounts + Vaults** — Login (JWT/bcrypt), beliebig viele teilbare Vaults pro User (User → Vault → Modul → Tile)
- **Storage** = direkt im GitHub-Repo (`vaults/<vid>/modules/<mid>/data.js` + `…/files/…`)
- **Hosting** = einzelner Node-Prozess (`server.js`), self-hosted hinter Cloudflare Tunnel
- **Anki .apkg**-Export + bidirektionaler AnkiConnect-Sync

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

### 2. Hosting

CrashVault läuft als **einzelner Node-Prozess** (`server.js`) — kein Vercel,
keine Serverless-Functions mehr. Frontend + `/api/*`-Handler werden aus
demselben Prozess bedient.

**Produktiv** wird auf einem eigenen Ubuntu-Server gehostet, erreichbar via
Cloudflare Tunnel unter `crashvault.henrysoase.org`. Die komplette
Server-Anleitung (Node, systemd, Tunnel, Auto-Deploy via self-hosted
GitHub-Runner) steht in **[docs/SELFHOST.md](docs/SELFHOST.md)**.

**Environment-Variablen** (im `.env`, Vorlage `.env.example`):

- `GITHUB_TOKEN` — Personal Access Token, Contents = Read+Write auf das Repo.
- `GITHUB_OWNER` — `sxty9`.
- `GITHUB_REPO` — `CrashVault`.
- `GITHUB_BRANCH` — `main`.
- `JWT_SECRET` — mind. 32 Zeichen Zufall (`openssl rand -hex 32`). Ändern =
  alle Sessions raus.
- `PORT` — `29927` (`crc32("CrashVault") % 39151 + 10000`; nur an `127.0.0.1`
  gebunden, cloudflared proxied davor. 8080 ist für die spätere Hauptseite auf
  der Apex-Domain reserviert).

Beim ersten Aufruf der App siehst du den „Repo initialisieren"-Tab: erster
Account wird automatisch Admin. Danach: Login-Screen + optionaler Sign-Up
(Admin schaltet `allowSignup` frei).

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
cp .env.example .env   # ausfüllen (GITHUB_TOKEN, JWT_SECRET, …)
npm ci
npm start              # = node server.js → http://127.0.0.1:29927
```

Ein einziger Node-Prozess, kein Build-Step, kein Vercel-CLI. Änderungen an
`.js`/`.html` greifen nach Neustart (`Strg+C` + `npm start`); Frontend-Edits
sieht man nach Browser-Reload, da `server.js` Dateien bei jedem Request frisch
liest und HTML mit `Cache-Control: no-cache` ausliefert.

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
