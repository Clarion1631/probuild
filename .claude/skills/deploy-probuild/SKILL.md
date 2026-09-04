---
name: deploy-probuild
description: Deploy ProBuild to Vercel production. Git auto-deploy is ON, so merging a PR ships it live; the CLI is for shipping ahead of a merge. Use when deploying to prod, running the pre-deploy checklist, rotating the Vercel token, or troubleshooting a deploy that shipped ahead of its schema migration.
allowed-tools: Read, Bash, Grep, Glob
---

# Deploying ProBuild to Vercel

Git auto-deploy is **ON** (verified 2026-08-10, PR #342). `vercel.json` holds only `crons` — there is
no `git.deploymentEnabled` key and no dashboard override, so Vercel's default `true` applies.
**Merging a PR ships it live.** Run the pre-deploy checklist before merging, not just before the CLI.

## Production deploy command

```powershell
vercel --prod --yes --cwd "C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site"
```

## Hard rule: never pass `--token`

On success the Vercel CLI prints a "next steps" block that replays your command line back —
including the token value — into the terminal and the session transcript. That has leaked the
production token at least twice (PR-209, and again 2026-08-09), each time forcing a rotation.

The flag is unnecessary. The CLI authenticates on its own, in this precedence order:

1. `--token` on the command line (never use it);
2. a **non-empty** `VERCEL_TOKEN` in the environment;
3. otherwise the persisted login at `%APPDATA%\com.vercel.cli\Data\auth.json` (from `vercel login`).

2 and 3 are read silently and never echoed. This applies to every authenticating subcommand
(`deploy`, `env`, `logs`, `inspect`), not just `--prod`.

A stale `VERCEL_TOKEN` fails every **authenticated** command — `Error: The token provided via
VERCEL_TOKEN environment variable is not valid` — even when the persisted login is healthy. An
invalid explicit credential does not fall back. Local-only commands like `vercel --version` still
succeed, so don't use those to test auth.

Verify auth before deploying — this should print `jadkins-4713`:

```powershell
vercel whoami
```

## Rotating the token

Never put the value on a command line. `setx VERCEL_TOKEN "<value>"` is the same leak class this
page exists to prevent — it lands the secret in argv, shell history, and any agent transcript.
Justin does this himself, in his own terminal:

- Windows GUI: Settings → *Edit environment variables for your account* → edit `VERCEL_TOKEN`; or
- PowerShell, value read from a prompt instead of argv. It **must** be `-AsSecureString`: a bare
  `Read-Host` echoes the pasted token to the screen and into terminal scrollback, and PowerShell 5.1
  (this machine) has no `-MaskInput`.

  ```powershell
  $s = Read-Host 'Paste token' -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try {
    [Environment]::SetEnvironmentVariable('VERCEL_TOKEN', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b), 'User')
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
  }
  ```

Only new shells see the change, and it is Windows-only — WSL needs its own copy. Claude must never
be given the token value.

## Scope of the guard hook

`~/.claude/hooks/block-vercel-token.mjs` (wired as a `PreToolUse` hook in `~/.claude/settings.json`)
blocks `vercel` commands carrying `--token`/`-t`/an inline `VERCEL_TOKEN=`. It is defence-in-depth
only: it covers Claude's Bash/PowerShell calls **on this machine** and nothing else — not a manual
terminal, not CI, not Codex, not another machine.

It also does not cover other secret-bearing paths: `--env KEY=VALUE` and `--build-env KEY=VALUE`
put values in argv, and `vercel env pull` / `vercel pull` write every production env var in
plaintext to `.env*` and `.vercel/.env.production.local`. Those files are gitignored but readable
by any tool or backup — treat them as live secrets.

## Pre-deploy checklist (in order)

1. `npm run build` passes locally with 0 errors.
2. **Schema changed?** If the branch edits `prisma/schema.prisma` and ships a `scripts/apply-*.mjs`, run it against prod BEFORE deploying:
   ```bash
   node scripts/apply-<name>.mjs
   ```
   These scripts are additive and idempotent (`IF NOT EXISTS`, guarded FKs) and safe to run while the old build is still live. But the new build's Prisma client selects the new columns immediately, so any page querying them throws P2022 "column does not exist" until the script runs.

   The `schema-drift` CI job (`.github/workflows/ci.yml`) now gates this automatically: it runs on **every** pull request (not just ones that touch schema paths, so pre-existing drift also blocks the next deploy), queries prod's `information_schema`/`pg_enum`, and fails the PR if a table, column, or enum value the Prisma schema expects isn't there yet. Exit codes: `0` clean, `2` drift found, `1` any other failure (missing secret, connection error, empty DMMF). Verify locally with the same check before pushing:
   ```bash
   node scripts/check-schema-drift.mjs
   ```

   > 2026-07-20: the company-schedule deploy went out before `apply-company-schedule-schema.mjs` ran. Project pages hit the route error boundary until it was applied.
   > 2026-08-29 → 2026-09-02: PR #406 (Inspection table) merged and auto-deployed without `apply-inspections-schema.mjs`; staff and client project pages were down four days before a customer reported it. The `schema-drift` CI job now fails the PR until the table/columns exist in prod.
3. Deploy with the command above, then click through the affected pages on prod.

## Why the flags are what they are

- `--archive=tgz` is **optional**, not required (corrected 2026-08-10, PR #342). With the current
  `.vercelignore` the source upload measures ~1,389 files against a 15,000-file cap. Archive mode
  bundles everything into one tarball, which defeats per-file upload caching and can make repeat
  deploys slower — add it only if an upload actually stalls.
- `--cwd` points at the main repo. Deploy from there, never from a worktree — worktrees lack the `.vercel` link.
- Only deploy when changes are verified locally via `npm run build`.

## Cost note

An older note here claimed auto-deploy had been turned off after a ~$250 bill from frequent builds.
It was never actually disabled (see the top of this page). No checked-in config throttles build
volume — no `ignoreCommand`, no Ignored Build Step — so keep pushes deliberate.

## Reference

- Vercel project ID: `prj_sd7R3WIYZCRMnu5IhAudBdc4vuIL`
- Production: https://probuild.goldentouchremodeling.com
- Vercel preview: https://probuild-amber.vercel.app
