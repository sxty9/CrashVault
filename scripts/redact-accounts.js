// Writes a hash-redacted copy of accounts.json for the offsite backup.
//
// The real accounts.json (with bcrypt password hashes) is gitignored in the
// data backup repo and never leaves the host. This redacted copy keeps the
// account RECORDS (id, username, displayName, role) so the user↔vault linkage
// survives a restore — only the passwordHash is replaced with a sentinel.
// After restoring, set a real password with scripts/set-password.js.
//
// No dependencies (fs/path only), so the systemd backup timer can run it.

"use strict";
const fs = require("fs");
const path = require("path");

const DATA = process.env.CRASHVAULT_DATA_DIR || "/var/lib/crashvault";
const src = path.join(DATA, "accounts.json");
const dst = path.join(DATA, "accounts.redacted.json");

let raw;
try { raw = fs.readFileSync(src, "utf8"); }
catch (e) { process.exit(0); } // no accounts yet → nothing to back up

const data = JSON.parse(raw);
for (const a of (data.accounts || [])) {
  if (a.passwordHash) a.passwordHash = "RESET_REQUIRED";
}
const tmp = dst + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmp, dst);
