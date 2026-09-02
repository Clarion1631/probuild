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
| `rolcreatedb` on that role | **true** |
| `rolsuper` | false |
| Connect with `/template1` instead of `/postgres` | **succeeds** — the pooler is not pinned to a single database |
| `prisma migrate diff --from-schema-datasource` | connects, introspects, emits a diff |
| `prisma migrate status` | connects, reads `_prisma_migrations` |

So the IPv6 problem is genuinely solved by the pooler.

**The shadow-database question is still open.** Those two rows clear two *preconditions* — the role
advertises `CREATEDB`, and Supavisor will route to a database other than `postgres` — but the actual
shadow lifecycle (`CREATE DATABASE` through the pooler, connecting to the freshly created random
database, `DROP DATABASE`) was **not** attempted, because doing so mutates the production server.
Do not read the table as proof that shadow databases work here — only that the *privilege* objection
raised by earlier versions of this file is not the obstacle. In Prisma 5.22 the shadow work runs
early in `migrate dev`, so it remains the likeliest first failure whenever someone does try it.

### What stops it anyway: prod has diverged from the repo

Both mutating commands are unusable against `ghzdbzdnwjxazvmcefbh` regardless of how you connect,
because the live database holds a large set of tables and columns that the checked-in
`prisma/schema.prisma` does not model. (Neither mutating command was run **against production** —
every statement below is read from `migrate diff` / `migrate status` output. The `db push` runs in
the evidence table above were against a throwaway container.) The likeliest cause is SQL
applied by hand via the script below without updating `schema.prisma` in lockstep, but the probes
show only the divergence, not its cause — deleted migration files or deliberately-kept legacy
objects would look the same.

This diff, run with a clean **`main`** worktree's schema on both sides (`--from-schema-datasource`
introspects the live database named by that file's datasource; `--to-schema-datamodel` reads its
models), returns 240 lines of DDL:

```
prisma migrate diff \
  --from-schema-datasource <clean-main>/prisma/schema.prisma \
  --to-schema-datamodel   <clean-main>/prisma/schema.prisma \
  --script
```

Both options need an explicit path, and without `--script` Prisma 5.22 prints a human-readable
summary instead of DDL. Read in the direction `db push` would apply it, that is:

- **10 `DROP TABLE`** — `AuditLog`, `McpKey`, `Notification`, `HelpRequest`, `RolloutGate`,
  `QboPurchaseClassification`, `ReviewAlertBatch`, `ReviewAlertEpisode`, `ReviewIssue`,
  `_SelectionProposalStatusBackup`
- **41 `DROP COLUMN`** across 24 tables — including the whole soft-delete set
  (`deletedAt` / `deletedById` / `deleteBatchId` on `Client`, `Lead`, `Estimate`, `EstimateItem`,
  `EstimatePaymentSchedule`, `Project`), `Invoice.qbInvoiceId` + `qbSyncedAt`,
  `Estimate.qbEstimateId` + `qbSyncedAt`, `Project.googleChatSpaceId` + `qbProjectId`, and six
  `TimeEntry` columns
- 13 `DROP INDEX`, plus assorted `DECIMAL(65,30)` and `TIMESTAMP(3)` retypes

That is the synchronization `db push` would **propose**, not something it was observed doing — it was
never run against prod. **Do not run it here to find out.**

Do not lean on the `--accept-data-loss` guardrail either. Prisma 5.22 only aborts when the engine
returns a nonempty `migration.warnings`, and it raises those per *object that actually holds rows* —
which the diff above does not tell us. So it is unknown how many of those 10 tables and 41 columns
would even trigger a warning; the rest would just go. And the drops that do warn are one flag away
from anyone trying to "get past the error".

`prisma migrate dev` is also blocked, by divergent history. `migrate status` over the pooler
reports:

```
The last common migration is: null
The migration have not yet been applied: sprint5_baseline
The migration from the database are not found locally in prisma/migrations: 20260307033916_init
```

With no common ancestor, the expected outcome is that `migrate dev` demands a full database
**reset** — but `migrate dev` was not run, so treat that as inference from `migrate status`, not an
observation. Note the ordering: in Prisma 5.22 the dev diagnostic does its shadow-database drift and
validation work *before* it returns the reset decision, so the untested shadow lifecycle would
actually be hit **first**, and could fail before history is ever the reported problem. It could also
error rather than prompt when stdin is not a TTY. Either way it does not do useful work here.

Neither knob rescues it, for different reasons:

- `--shadow-database-url` only supplies a different scratch database. In Prisma 5.22 it is a
  `migrate diff` option anyway; `migrate dev` reads the datasource's `shadowDatabaseUrl` field. Both
  address *where* the shadow lives, never the datamodel-vs-database gap.
- `migrate resolve` is the right tool for divergent *history* and is part of the fix below — but it
  only writes rows in `_prisma_migrations`. It cannot reconcile the schema itself.

**Watch the branch you diff from.** The canonical checkout usually sits on dirty WIP (it was on
`feat/unified-money-register` during this test), and its `schema.prisma` predates
`Estimate.itemsRevision` among other things. The same diff run from that branch returned **270**
lines against **240** from a clean `main` worktree, so ~30 lines were branch artifact rather than
real drift. Diff from clean `main`, or the numbers are meaningless.

### What it would take to retire `apply_schema.ps1`

Not a connection change **alone** — the connection fix is necessary but nowhere near sufficient. The
missing piece is a **baseline reconciliation**, which is its own project:

1. `prisma db pull` into a scratch schema and reconcile it against `main`'s `schema.prisma`, deciding
   per object whether prod is right (adopt it) or the table/column is dead (drop it deliberately).
2. Squash `prisma/migrations` to a single baseline matching reconciled prod and
   `prisma migrate resolve --applied` it. Note that this alone does **not** make the histories agree:
   `resolve --applied` inserts the baseline row, it does not remove the existing
   `20260307033916_init` row that has no local counterpart. That stale row has to be reconciled
   separately or `migrate status` keeps reporting divergence.
3. Prove the shadow-database lifecycle actually works through the session pooler (the untested gap
   above), or configure `shadowDatabaseUrl` to point somewhere that does.
4. Only then adopt the normal workflow: run `migrate dev` against a **disposable development
   database**, never against prod, and ship the generated migrations to prod with `migrate deploy`.
   `migrate dev` is development-only by design — pointing it at `DIRECT_URL` is pointing it at the
   live database.
5. Keep `DIRECT_URL` on the session pooler for step 4 to work at all. `migrate deploy` dials
   `directUrl` like every other migration command, so from this machine it needs the pooler (or an
   IPv6-capable runner) exactly as much as the rest do. This is where the pooler finding pays off —
   it is a precondition of the end state, just not a fix on its own.

Until steps 2–3 land, use the PowerShell script below — and keep `schema.prisma` in sync with every
SQL change you apply. Whatever caused the existing drift, that habit is what stops it growing.

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

Every apply script must be **inert on import**: dotenv loading, `new PrismaClient(...)`, and every DDL/query execution live inside `async function main()` (SQL string constants may stay at module scope), invoked only from `const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;` followed by exactly one `if (isMainModule) { await main(); }` block (that exact two-statement shape; the test rejects an inline condition). `tests/apply-scripts-inert-on-import.test.ts` (in `npm run test:unit`) checks that exact guard shape, allows only imports with bindings, function declarations, inert `const`/`let` declarations, and plain `export { ... }` lists at module scope (so no dotenv, PrismaClient, raw SQL, unguarded top-level `await`, `process.exit`, re-export, or any other call runs on import), and imports every `scripts/apply-*.mjs` in a scrubbed child process with `DATABASE_URL` pointed at a dummy TCP listener that must see no connection. It detects that specific syntax plus observed connections, not arbitrary side effects. Run a script by its real path: through a symlink or junction the guard no-ops silently (you will see no `applied` output). Reason: on 2026-09-02 an `import` of `apply-payroll-phase5.mjs`, done only to look at its exports, ran the whole migration against production. Never import an apply script to inspect it — read it as text.

## Connection gotcha

`DATABASE_URL` must include `?pgbouncer=true` — Supabase transaction pooler (port 6543) plus Prisma requires it. Without it you get `42P05 prepared statement already exists` and the site goes down.

```
postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true
```

`DIRECT_URL` uses port 5432 on `db.ghzdbzdnwjxazvmcefbh.supabase.co`, for the Prisma CLI operations
that need a direct connection (`migrate`, `db push`, Studio) — not just migrations.
