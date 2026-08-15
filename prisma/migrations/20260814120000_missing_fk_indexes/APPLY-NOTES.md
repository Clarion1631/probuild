# Applying this migration to production

Prod DDL for this repo does not go through `prisma migrate deploy` (see CLAUDE.md "Schema
migrations"). This migration was applied manually via a **direct database session** (not the
Supavisor transaction pooler — it silently ignores `lock_timeout` startup options, and
`CREATE INDEX CONCURRENTLY` semantics need a real session; a scripted applier over the pooler
was reviewed by Codex on 2026-08-14 and rejected for exactly those reasons, then removed).

Order applied (2026-08-14, ~17:00 PT, zero-traffic window; tables are small — the whole set
holds locks for milliseconds):

1. The three `CREATE INDEX` statements (plain, not CONCURRENTLY — acceptable at this table
   size and traffic; use CONCURRENTLY from a direct session if ever re-run under load).
2. Orphan checks for `Project.managerId` and `Project.leadId` (must return 0 rows).
3. `Project_managerId_fkey`: `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE CONSTRAINT`.
4. The five referential-action alignments: `DROP CONSTRAINT` + `ADD CONSTRAINT` in one
   transaction each (enforcement never absent), then `VALIDATE`.
5. `Project_leadId_fkey` (SET NULL → RESTRICT) **last**, and only after the deleteLead
   transaction fix in this same PR was deployed — old code could partial-delete a lead
   (contracts removed, lead stuck) once RESTRICT exists.

A racing write between an orphan check and its `ADD ... NOT VALID` surfaces as a failed
`VALIDATE`, which is recoverable: fix the row, re-run `VALIDATE`. That trade (rather than
explicit table locks) is deliberate — reviewed alternative, small-DB context.

Verification: catalog queries asserting all 7 FKs exist with the schema's exact
`confupdtype`/`confdeltype` action codes and all 3 indexes are `indisvalid AND indisready`.
