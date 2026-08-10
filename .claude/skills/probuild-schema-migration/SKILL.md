---
name: probuild-schema-migration
description: Apply a Prisma/Postgres schema change in ProBuild. The normal Prisma migration commands do not work against this Supabase setup, so schema changes go through a PowerShell SQL script instead. Use when adding columns or tables, editing prisma/schema.prisma, or regenerating the Prisma client.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# ProBuild schema migrations

## Why the standard commands don't work

- `npx prisma db push` hangs interactively.
- `prisma migrate dev` fails — port 5432 is blocked on the free tier.

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
