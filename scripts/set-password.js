// Restore helper: set a new password for an EXISTING account, preserving its
// user id (so vault membership/ownership stays intact). Use after restoring a
// redacted backup (see redact-accounts.js) where passwordHash is "RESET_REQUIRED".
//
//   node scripts/set-password.js <username> <newPassword>
//
// If accounts.json is missing but accounts.redacted.json exists, it seeds from
// the redacted copy first.

"use strict";
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DATA = process.env.CRASHVAULT_DATA_DIR || "/var/lib/crashvault";
const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("usage: node scripts/set-password.js <username> <newPassword>");
  process.exit(1);
}
if (password.length < 8) { console.error("password must be at least 8 chars"); process.exit(1); }

const file = path.join(DATA, "accounts.json");
let data;
if (fs.existsSync(file)) {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} else {
  const red = path.join(DATA, "accounts.redacted.json");
  if (!fs.existsSync(red)) { console.error("no accounts.json or accounts.redacted.json in " + DATA); process.exit(1); }
  data = JSON.parse(fs.readFileSync(red, "utf8"));
  console.log("(seeded from accounts.redacted.json)");
}

const acc = (data.accounts || []).find(a => a.username === username);
if (!acc) { console.error("no account with username: " + username); process.exit(1); }

acc.passwordHash = bcrypt.hashSync(password, 12);
acc.tokenVersion = (acc.tokenVersion || 0) + 1; // invalidate any stray sessions

const out = {
  accounts: data.accounts,
  config: data.config || { allowSignup: false },
  _meta: { lastSaved: new Date().toISOString() }
};
const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
fs.renameSync(tmp, file);
console.log(`password set for "${username}" (id ${acc.id}) — log in, then change it in the app.`);
