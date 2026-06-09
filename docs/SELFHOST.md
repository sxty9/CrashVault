# CrashVault Self-Hosting (Ubuntu + Cloudflare Tunnel)

Runbook für den Umzug von Vercel auf den eigenen Ubuntu-Server, erreichbar
unter `https://crashvault.henrysoase.org` via Cloudflare Tunnel (sxgate).

Architektur:

```
Browser ──HTTPS──▶ Cloudflare-Edge ──Tunnel──▶ cloudflared ──HTTP──▶ node server.js
   crashvault.henrysoase.org                    (127.0.0.1:8080)
```

CrashVault selbst ist ein einzelner Node-Prozess (`server.js`), der die
Frontend-Dateien ausliefert und `/api/*` an dieselben Handler routet, die
vorher auf Vercel liefen. Daten leben weiterhin im GitHub-Repo.

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
| `GITHUB_TOKEN` | derselbe PAT wie auf Vercel (Contents R+W) |
| `GITHUB_OWNER` | `sxty9` |
| `GITHUB_REPO` | `CrashVault` |
| `GITHUB_BRANCH` | `main` |
| `JWT_SECRET` | **exakt** der Vercel-Wert |
| `PORT` | `8080` |

Test direkt:

```bash
node server.js
# → "CrashVault listening on http://127.0.0.1:8080"
# → "Registered 20 API endpoints"
# In zweitem Terminal:
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/        # 200
curl -s http://127.0.0.1:8080/api/auth/me                              # 200/401/410 JSON
# Strg+C zum Beenden.
```

---

## 4. systemd-Service

`/etc/systemd/system/crashvault.service` (ersetze `<user>`):

```ini
[Unit]
Description=CrashVault Node-Service
After=network.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/Code/CrashVault
EnvironmentFile=/home/<user>/Code/CrashVault/.env
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
    service: http://localhost:8080
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
sudo ./svc.sh install <user>
sudo ./svc.sh start
sudo ./svc.sh status
```

### 6b. Passwordless sudo für den Restart

`/etc/sudoers.d/crashvault` (via `sudo visudo -f /etc/sudoers.d/crashvault`):

```
<user> ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart crashvault
```

(Pfad prüfen: `which systemctl` — meist `/usr/bin/systemctl`.)

### 6c. Repo-Variablen setzen

GitHub → Repo → Settings → Secrets and variables → Actions → **Variables**:

| Variable | Wert |
|---|---|
| `DEPLOY_DIR` | `/home/<user>/Code/CrashVault` |
| `APP_PORT` | `8080` |

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
2. Login funktioniert (accounts.js liegt im Repo, JWT_SECRET identisch) ✓
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
| API 500 „GITHUB_TOKEN missing" | `.env` nicht geladen — `EnvironmentFile`-Pfad im Service prüfen |
| Anki „Failed to fetch" | CORS-Origin in AnkiConnect nicht aktualisiert (Schritt 7.4) |
| Deploy-Run hängt | Runner-Dienst tot: `sudo ~/actions-runner/svc.sh status` |
| `sudo: a password is required` im Run | sudoers-Eintrag (6b) fehlt oder falscher systemctl-Pfad |

Logs:
- App: `journalctl -u crashvault -f`
- Tunnel: `journalctl -u cloudflared -f`
- Runner: `journalctl -u actions.runner.* -f`
