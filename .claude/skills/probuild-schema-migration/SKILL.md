---
name: probuild-schema-migration
description: Apply a Prisma/Postgres schema change in ProBuild. The normal Prisma migration commands do not work against this Supabase setup, so schema changes go through a PowerShell SQL script instead. Use when adding columns or tables, editing prisma/schema.prisma, or regenerating the Prisma client.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# ProBuild schema migrations

## Why the standard commands don't work

- `npx prisma db push` does **not** hang — that claim was never verified and is wrong. It fails for
  the *same* reason `migrate dev` does: when the datasource block sets `directUrl`, Prisma uses
  `DIRECT_URL` — not `DATABASE_URL` — as the connection target for `db push`. It errors out in ~3
  seconds with `P1001: Can't reach database server at db.ghzdbzdnwjxazvmcefbh.supabase.co:5432`.
  (`DATABASE_URL` must still be **set**, it just isn't the one dialled: Prisma validates `url` first
  and fails with `P1012: Environment variable not found: DATABASE_URL` before it connects.)
- `prisma migrate dev` fails because it connects over `DIRECT_URL`, and this project's direct
  endpoint `db.ghzdbzdnwjxazvmcefbh.supabase.co` resolves to an **AAAA record only** — Supabase
  direct connections are IPv6-only unless the project buys the IPv4 add-on. This machine has no
  IPv6 default route, so the TCP connection to that host fails.

**It is not a blocked port, and not a free-tier port block.** There is no host-wide outbound block
on 5432: Supabase's shared **session** pooler also listens on 5432 and completes a TCP handshake
over IPv4 from this machine. (Plan tier does affect whether the IPv4 add-on is *purchasable* — it
just isn't what breaks the command.) Verified 2026-08-10 from this machine:

| Endpoint | DNS | TCP handshake |
|---|---|---|
| `db.ghzdbzdnwjxazvmcefbh.supabase.co:5432` (direct) | AAAA only, no A record | fails |
| `aws-0-us-west-2.pooler.supabase.com:5432` (session pooler) | A records | succeeds |
| `aws-0-us-west-2.pooler.supabase.com:6543` (transaction pooler) | A records | succeeds |

Authenticated access over the session pooler **was** tested on 2026-08-13 — see
"Repointing `DIRECT_URL` at the session pooler" below. It works. It still does not make the normal
migration commands usable, for a completely different reason.

### `db push` evidence (verified 2026-08-10)

Run against a throwaway `postgres:16` container, never prod, since `db push` mutates the database.
Prisma CLI 5.22.0.

| Test | Result |
|---|---|
| Both URLs → throwaway container | **Succeeds in 9s**, no prompt. So there is no inherent hang. |
| `DATABASE_URL` → throwaway, `DIRECT_URL` → real direct host | Banner names **the direct host**, then `P1001` in 3.3s. Proves `db push` connects over `directUrl`, ignoring `DATABASE_URL` **as the connection target**. |
| `DIRECT_URL` set, `DATABASE_URL` unset | `P1012: Environment variable not found: DATABASE_URL`. So `url` is still *validated* — `directUrl` only overrides which one is dialled. |
| Destructive change (drop a column holding data), stdin not a TTY | **Errors in 2.5s** with *"Use the --accept-data-loss flag"*. It does not block waiting for input. |

That destructive-change confirmation is the prompt we tested. `db push` has a second one (a change
it can't execute without a full database reset) that we did **not** test. On a real TTY both do
genuinely prompt; when stdin is not a TTY — which is how CI and Claude Code's Bash tool invoke it —
the tested one errors immediately instead of blocking. The IPv6 problem is
also not WSL-specific: from WSL, `getent ahosts` on the direct host returns the same lone AAAA
address and `ip -6 route show default` is empty, exactly as on Windows.

## Repointing `DIRECT_URL` at the session pooler (tested 2026-08-13)

**It fixes the connection. It does not fix the migration commands.** Do not spend time retrying
this — the blocker moved, it did not go away.

Test URL: the `DATABASE_URL` value with the port changed `6543` → `5432` and the `?pgbouncer=true`
query string dropped. Same tenant-qualified user (`postgres.ghzdbzdnwjxazvmcefbh`), same password.

### What works

Authenticated Postgres over the session pooler succeeds from this machine. Verified with a
read-only `PrismaClient` (`datasourceUrl` override, catalog `SELECT`s only) and with two read-only
Prisma CLI commands:

| Probe | Result |
|---|---|
| `SELECT current_user` | `postgres` |
| `SHOW server_version` | `17.6` |
| `rolcreatedb` on that role | **true** — so a shadow database is not blocked by role privilege |
| `rolsuper` | false |
| Connect with `/template1` instead of `/postgres` | **succeeds** — the pooler is not pinned to one database, so a shadow DB is reachable in principle |
| `prisma migrate diff --from-schema-datasource` | connects, introspects, emits a diff |
| `prisma migrate status` | connects, reads `_prisma_migrations` |

So the IPv6 problem is genuinely solved by the pooler, and the shadow-database concern flagged in
earlier versions of this file is **not** what stops `migrate dev`.

### What stops it anyway: prod has diverged from the repo

Both mutating commands are unusable against `ghzdbzdnwjxazvmcefbh` regardless of how you connect,
because years of applying SQL by hand (the script below) without updating `prisma/schema.prisma` in
lockstep have left the live database ahead of the checked-in schema.

`prisma migrate diff --from-schema-datasource --to-schema-datamodel` against **`main`** returns 240
lines of DDL. Read in the direction `db push` would apply it, that is:

- **10 `DROP TABLE`** — `AuditLog`, `McpKey`, `Notification`, `HelpRequest`, `RolloutGate`,
  `QboPurchaseClassification`, `ReviewAlertBatch`, `ReviewAlertEpisode`, `ReviewIssue`,
  `_SelectionProposalStatusBackup`
- **41 `DROP COLUMN`** across 24 tables — including the whole soft-delete set
  (`deletedAt` / `deletedById` / `deleteBatchId` on `Client`, `Lead`, `Estimate`, `EstimateItem`,
  `EstimatePaymentSchedule`, `Project`), `Invoice.qbInvoiceId` + `qbSyncedAt`,
  `Estimate.qbEstimateId` + `qbSyncedAt`, `Project.googleChatSpaceId` + `qbProjectId`, and six
  `TimeEntry` columns
- 13 `DROP INDEX`, plus assorted `DECIMAL(65,30)` and `TIMESTAMP(3)` retypes

So **`prisma db push` would connect fine and then destroy production data.** Never run it here.

`prisma migrate dev` fails earlier still. `migrate status` over the pooler reports:

```
The last common migration is: null
The migration have not yet been applied: sprint5_baseline
The migration from the database are not found locally in prisma/migrations: 20260307033916_init
```

With no common ancestor, `migrate dev`'s first move is to ask for a full database **reset**. Neither
`--shadow-database-url` nor `migrate resolve` helps — those address shadow-DB and applied-state
bookkeeping, not a schema that the datamodel no longer describes.

**Watch the branch you diff from.** The canonical checkout usually sits on dirty WIP (it was on
`feat/unified-money-register` during this test), and its `schema.prisma` predates `Estimate.itemsRevision`
among other things. Diffing against that branch inflates the drift with ~30 lines of pure artifact.
Diff from a clean `main` worktree, or the numbers are meaningless.

### What it would take to retire `apply_schema.ps1`

Not a connection change — a **baseline reconciliation**, which is its own project:

1. `prisma db pull` into a scratch schema and reconcile it against `main`'s `schema.prisma`, deciding
   per object whether prod is right (adopt it) or the table/column is dead (drop it deliberately).
2. Squash `prisma/migrations` to a single baseline matching reconciled prod, and
   `prisma migrate resolve --applied` it so local history and `_prisma_migrations` agree.
3. Only then point `DIRECT_URL` at the session pooler and let `migrate dev` take over.

Until step 2 lands, use the PowerShell script below — and keep `schema.prisma` in sync with every
SQL change you apply, which is the discipline whose absence created this drift.

See <https://supabase.com/docs/guides/database/connecting-to-postgres> and
<https://supabase.com/docs/guides/platform/ipv4-address>.

## Working approach

1. Edit the SQL in `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`.
2. Run it:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"
   ```
3. Regenerate the client **from PowerShell**, never Git Bash:
   ```powershell
   powershell -Command "cd 'C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site'; node_modules\.bin\prisma generate"
   ```
   Git Bash triggers `copyEngine: false`, which breaks the local dev engine.
4. Update `prisma/schema.prisma` to match the SQL you just applied.

## Shipping the change

If the branch will deploy, also add a `scripts/apply-<name>.mjs` (additive, idempotent — `IF NOT EXISTS`, guarded FKs) and run it against prod **before** deploying. See the `deploy-probuild` skill.

## Connection gotcha

`DATABASE_URL` must include `?pgbouncer=true` — Supabase transaction pooler (port 6543) plus Prisma requires it. Without it you get `42P05 prepared statement already exists` and the site goes down.

```
postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true
```

`DIRECT_URL` uses port 5432 on `db.ghzdbzdnwjxazvmcefbh.supabase.co`, for the Prisma CLI operations
that need a direct connection (`migrate`, `db push`, Studio) — not just migrations.
