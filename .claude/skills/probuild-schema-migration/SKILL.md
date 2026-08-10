---
name: probuild-schema-migration
description: Apply a Prisma/Postgres schema change in ProBuild. The normal Prisma migration commands do not work against this Supabase setup, so schema changes go through a PowerShell SQL script instead. Use when adding columns or tables, editing prisma/schema.prisma, or regenerating the Prisma client.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# ProBuild schema migrations

## Why the standard commands don't work

- `npx prisma db push` does **not** hang — that claim was never verified and is wrong. It fails for
  the *same* reason `migrate dev` does: `db push` reads `directUrl` from the datasource block, so it
  dials `DIRECT_URL` and never touches `DATABASE_URL`. It errors out in ~3 seconds with
  `P1001: Can't reach database server at db.ghzdbzdnwjxazvmcefbh.supabase.co:5432`.
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

Those handshakes prove reachability only — nobody has tested authenticated Postgres access on the
session pooler.

### `db push` evidence (verified 2026-08-10)

Run against a throwaway `postgres:16` container, never prod, since `db push` mutates the database.
Prisma CLI 5.22.0.

| Test | Result |
|---|---|
| Both URLs → throwaway container | **Succeeds in 9s**, no prompt. So there is no inherent hang. |
| `DATABASE_URL` → throwaway, `DIRECT_URL` → real direct host | Banner names **the direct host**, then `P1001` in 3.3s. Proves `db push` uses `directUrl` and ignores `DATABASE_URL`. |
| Destructive change (drop a column holding data), stdin not a TTY | **Errors in 2.5s** with *"Use the --accept-data-loss flag"*. It does not block waiting for input. |

The only prompt `db push` has is that destructive-change confirmation, and it only appears on a real
TTY — under an agent or any non-TTY stdin it is an immediate error, not a hang. The IPv6 problem is
also not WSL-specific: from WSL, `getent ahosts` on the direct host returns the same lone AAAA
address and `ip -6 route show default` is empty, exactly as on Windows.

Repointing `DIRECT_URL` at the session pooler is therefore **not** a tested workaround. `prisma
migrate dev` also wants to create and drop a shadow database, which needs `CREATEDB` on the
database role used through the pooler. Untested here. Use the PowerShell script below instead.

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

`DIRECT_URL` uses port 5432 on `db.ghzdbzdnwjxazvmcefbh.supabase.co`, for migrations only.
