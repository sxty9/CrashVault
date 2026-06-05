// POST   /api/vault-invite?id=<vid>   body: { expiresInDays?, maxUses? } → { invite }
// DELETE /api/vault-invite?id=<vid>&code=<c>                              → { ok }
//
// Owner-only. Invite codes are URL-safe random (~16 chars). Default
// expiresInDays=30, maxUses=1. POST returns the full invite incl. the
// generated code; the UI displays a copyable URL with ?join=<code>.

const crypto = require("crypto");
const gh = require("./_github.js");
const auth = require("./_auth.js");

const MAX_INVITES_PER_VAULT = 50; // soft cap to keep config.js small

function genCode() {
  return crypto.randomBytes(12).toString("base64url");
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const vaultId = url.searchParams.get("id");
    const ctx = await auth.requireVaultOwner(req, vaultId);
    const config = await gh.readVaultConfig(vaultId) || { id: vaultId, name: ctx.vault.name, invites: [] };

    if (req.method === "POST") {
      const { expiresInDays, maxUses } = await gh.readJson(req);
      const ttlDays = Math.min(Math.max(parseInt(expiresInDays, 10) || 30, 1), 365);
      const uses = (maxUses === null || maxUses === undefined) ? 1 : Math.max(parseInt(maxUses, 10) || 1, 1);
      const now = new Date();
      const invite = {
        code: genCode(),
        createdBy: ctx.user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlDays * 86400000).toISOString(),
        maxUses: uses,
        uses: 0
      };
      config.invites = (config.invites || []).filter(i => new Date(i.expiresAt) > now);
      if (config.invites.length >= MAX_INVITES_PER_VAULT) {
        return gh.sendJson(res, 429, { error: `Maximal ${MAX_INVITES_PER_VAULT} aktive Invites pro Vault` });
      }
      config.invites.push(invite);

      await commitConfig(ctx, vaultId, config, `Invite-Code erzeugt`);
      return gh.sendJson(res, 200, { invite });
    }

    if (req.method === "DELETE") {
      const code = url.searchParams.get("code");
      if (!code) return gh.sendJson(res, 400, { error: "code-Param fehlt" });
      const before = (config.invites || []).length;
      config.invites = (config.invites || []).filter(i => i.code !== code);
      if (config.invites.length === before) return gh.sendJson(res, 404, { error: "Invite nicht gefunden" });

      await commitConfig(ctx, vaultId, config, `Invite widerrufen`);
      return gh.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "POST, DELETE");
    return gh.sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return gh.sendError(res, e);
  }
};

async function commitConfig(ctx, vaultId, config, summary) {
  const refSha = await gh.getRefSha();
  const baseCommit = await gh.getCommit(refSha);
  const blob = await gh.createBlob(gh.utf8ToB64(gh.buildVaultConfig(config)));
  const tree = await gh.createTree(baseCommit.tree.sha, [
    { path: gh.vaultConfigPath(vaultId), mode: "100644", type: "blob", sha: blob.sha }
  ]);
  await auth.loadUserContext(ctx.user);
  const author = (ctx.user.github && ctx.user.github.commitEmail)
    ? { name: ctx.user.github.login || ctx.user.username, email: ctx.user.github.commitEmail }
    : null;
  const commit = await gh.createCommit(
    `[${ctx.user.username}] ${ctx.vault.name}: ${summary}`,
    tree.sha, refSha, author
  );
  await gh.updateRef(commit.sha);
}
