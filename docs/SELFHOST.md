# CrashVault Self-Hosting (Ubuntu + Cloudflare Tunnel)

Runbook für den Umzug von Vercel auf den eigenen Ubuntu-Server, erreichbar
unter `https://crashvault.henrysoase.org` via Cloudflare Tunnel (sxgate).

> **Status: live seit 2026-06-16.** Der Umzug ist vollzogen — CrashVault läuft
> als systemd-Service `crashvault` aus `/home/nanu/CrashVault` und ist über den
> sxgate-Tunnel öffentlich erreichbar. Abweichungen vom ursprünglichen Plan:
> - **Deploy-Pfad:** das bereits vorhandene Repo-Clone `/home/nanu/CrashVault`
>   dient direkt als Deploy-Verzeichnis (kein separater `~/Code`-Clone).
> - **`GITHUB_TOKEN`:** der `gh`-CLI-Session-Token des Server-Users (`sxty9`,
>   `repo`-Scope = Contents R+W). Für mehr Stabilität kann hier später der
>   originale Vercel-PAT eingetragen werden.
> - **`JWT_SECRET`:** frisch erzeugt (der Vercel-Wert lag nicht vor) → bestehende
>   Sessions wurden einmalig ausgeloggt; die Logins aus `accounts.js` gelten weiter.
> - **Auto-Deploy-Runner (Abschnitt 6):** noch nicht eingerichtet — `git push`
>   deployt erst nach Registrierung des self-hosted Runners automatisch.

Architektur:

```
Browser ──HTTPS──▶ Cloudflare-Edge ──Tunnel──▶ cloudflared ──HTTP──▶ node server.js
   crashvault.henrysoase.org                    (127.0.0.1:29927)
```

CrashVault selbst ist ein einzelner Node-Prozess (`server.js`), der die
Frontend-Dateien ausliefert und `/api/*` an die Handler routet. **Alle
Nutzdaten leben auf der Server-Platte unter `/var/lib/crashvault`** (plain
JSON + Uploads) — das Repo enthält nur Code. Die einmalige Migration vom
früheren GitHub-Repo-Storage erledigt `scripts/migrate-to-disk.js`; Backup
siehe Abschnitt „Backup".

---

## 0. Voraussetzungen

- Ubuntu-Server, 24/7, mit `git` und `systemd` (Standard).
- cloudflared bereits eingerichtet (siehe `~/code/sxgate`), Tunnel `sxgate`
  existiert, Domain `henrysoase.org` ist bei Cloudflare aktiv.
- Der JWT_SECRET-Wert aus dem alten Vercel-Projekt (Vercel-Dashboard →
  Settings → Environment Variables). Identisch übernehmen, sonst werden alle
  bestehenden Logins ungültig.

---

## 1. Node 20 LTS installieren

Ubuntus `apt install nodejs` ist zu alt. NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v20.x
```

---

## 2. Repo klonen + Dependencies

```bash
mkdir -p ~/Code && cd ~/Code
git clone git@github.com:sxty9/CrashVault.git
cd CrashVault
npm ci --omit=dev
```

(SSH-Clone setzt voraus, dass der Server-User einen bei GitHub hinterlegten
SSH-Key hat. Sonst HTTPS-Clone + PAT.)

---

## 3. .env anlegen

```bash
cp .env.example .env
nano .env
```

Fülle aus:

| Variable | Wert |
|---|---|
| `JWT_SECRET` | 32+ Zeichen Zufall (`openssl rand -hex 32`); Ändern = alle Sessions raus |
| `PORT` | `29927` |
| `HOST` | `127.0.0.1` |
| `CRASHVAULT_DATA_DIR` | optional, Default `/var/lib/crashvault` |

(Ein GitHub-Token braucht die App **nicht** mehr — Daten liegen auf der Platte.)

Test direkt:

```bash
node server.js
# → "CrashVault listening on http://127.0.0.1:29927"
# → "Registered 20 API endpoints"
# In zweitem Terminal:
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:29927/        # 200
curl -s http://127.0.0.1:29927/api/auth/me                              # 200/401/410 JSON
# Strg+C zum Beenden.
```

---

## 4. systemd-Service

`/etc/systemd/system/crashvault.service` (ersetze `nanu`):

```ini
[Unit]
Description=CrashVault Node-Service
After=network.target

[Service]
Type=simple
User=nanu
WorkingDirectory=/home/nanu/CrashVault
EnvironmentFile=/home/nanu/CrashVault/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Aktivieren:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now crashvault
sudo systemctl status crashvault     # active (running)
journalctl -u crashvault -f          # Live-Logs
```

---

## 5. Cloudflare Tunnel → CrashVault

In `/etc/cloudflared/config.yml` einen `ingress`-Eintrag **vor** dem
Catch-all ergänzen:

```yaml
ingress:
  - hostname: crashvault.henrysoase.org
    service: http://localhost:29927
  # ... ggf. weitere Hosts ...
  - service: http_status:404
```

DNS-Record + Reload:

```bash
cloudflared tunnel route dns sxgate crashvault.henrysoase.org
sudo systemctl restart cloudflared
```

Browser-Check: `https://crashvault.henrysoase.org` → Login-Screen mit
HTTPS-Schloss.

---

## 6. Auto-Deploy: Self-hosted GitHub-Runner

Damit `git push` automatisch deployt — ohne offenen SSH-Port (passt zum
Tunnel-Prinzip: der Runner pollt GitHub nur ausgehend).

### 6a. Runner registrieren

GitHub → Repo → Settings → Actions → Runners → "New self-hosted runner" →
Linux. Folge den dort angezeigten Befehlen (Token ist personalisiert), etwa:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner-linux-x64.tar.gz -L \
  https://github.com/actions/runner/releases/download/vX.Y.Z/actions-runner-linux-x64-X.Y.Z.tar.gz
tar xzf actions-runner-linux-x64.tar.gz
./config.sh --url https://github.com/sxty9/CrashVault --token <RUNNER_TOKEN>
```

Als Dienst installieren (läuft als dein User, startet bei Boot):

```bash
sudo ./svc.sh install nanu
sudo ./svc.sh start
sudo ./svc.sh status
```

### 6b. Passwordless sudo für den Restart

`/etc/sudoers.d/crashvault` (via `sudo visudo -f /etc/sudoers.d/crashvault`):

```
nanu ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart crashvault
```

(Pfad prüfen: `which systemctl` — meist `/usr/bin/systemctl`.)

### 6c. Repo-Variablen setzen

GitHub → Repo → Settings → Secrets and variables → Actions → **Variables**:

| Variable | Wert |
|---|---|
| `DEPLOY_DIR` | `/home/nanu/CrashVault` |
| `APP_PORT` | `29927` |

Der Workflow `.github/workflows/deploy.yml` nutzt diese. Keine SSH-Secrets
nötig — der Runner läuft ja lokal.

### 6d. Test

```bash
git commit --allow-empty -m "test deploy" && git push
```

GitHub → Actions → der Run sollte grün durchlaufen; auf dem Server zeigt
`journalctl -u crashvault -f` den Neustart.

---

## 7. Cutover-Checkliste (Vercel abschalten)

1. Self-Host läuft + `https://crashvault.henrysoase.org` antwortet ✓
2. Login funktioniert (accounts.json liegt unter /var/lib/crashvault) ✓
3. Vault-Dashboard, BWL-Modul, Speichern getestet ✓
4. **AnkiConnect-CORS umstellen**: Anki → Extras → Erweiterungen →
   AnkiConnect → Konfiguration → in `webCorsOriginList` die alte
   `https://crash-vault.vercel.app` durch `https://crashvault.henrysoase.org`
   ersetzen → Anki neu starten.
5. Anki-Sync auf der neuen Domain testen.
6. **Vercel-Projekt löschen**: Vercel-Dashboard → CrashVault → Settings →
   Delete Project.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| 502 im Browser | `systemctl status crashvault` — läuft der Node-Prozess? |
| Login schlägt fehl, vorher ging's | JWT_SECRET ≠ Vercel-Wert → alle Sessions raus, einmal neu anmelden |
| API 500 / „not writable" | `/var/lib/crashvault` fehlt oder gehört nicht `nanu` — `sudo chown -R nanu:nanu /var/lib/crashvault` |
| Anki „Failed to fetch" | CORS-Origin in AnkiConnect nicht aktualisiert (Schritt 7.4) |
| Deploy-Run hängt | Runner-Dienst tot: `sudo ~/actions-runner/svc.sh status` |
| `sudo: a password is required` im Run | sudoers-Eintrag (6b) fehlt oder falscher systemctl-Pfad |

Logs:
- App: `journalctl -u crashvault -f`
- Tunnel: `journalctl -u cloudflared -f`
- Runner: `journalctl -u actions.runner.* -f`
