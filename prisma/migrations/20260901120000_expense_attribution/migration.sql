-- Expense attribution (Receipt Pipeline v2, Phase 3 —
-- docs/plans/PHASE-3-ATTRIBUTION-SPEC.md §2). Production gets these statements
-- through the guarded rollout script scripts/apply-expense-attribution.mjs;
-- this migration carries the SAME statements so a fresh database built from
-- prisma/migrations/ reproduces production. Keep both additive and idempotent.
--
-- `Expense` reached a project only through its required `estimateId` before
-- this. That traversal is still correct — the resolver in
-- src/lib/expense-attribution.ts prefers `projectId` and falls back to it —
-- but a denormalized column is what lets the money-path readers, the margin
-- digest, and the tax report ask "whose job was this?" without a join, and
-- what lets a receipt be born knowing its job.
--
-- The UPDATE is the backfill. It is idempotent (`WHERE "projectId" IS NULL`)
-- and a no-op on CI's empty database. scripts/backfill-expense-attribution.mjs
-- runs the same statement again — belt and braces, and it reports the count.

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "projectId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(65,30);
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeConfidence" DECIMAL(65,30);

CREATE INDEX IF NOT EXISTS "Expense_projectId_idx" ON "Expense"("projectId");

-- SET NULL, not Cascade: `estimateId` already owns this row's lifecycle. A
-- project delete must not silently destroy spend history that the estimate
-- still holds.
--
-- Guarded on the DEFINITION, not just the name (Codex round 1, issue 9). A
-- name-only `IF NOT EXISTS` silently accepts a pre-existing constraint of the
-- same name that points somewhere else or carries ON DELETE CASCADE — which is
-- precisely the failure this constraint exists to prevent. Existing-and-wrong
-- raises instead of being skipped: an operator has to look at it.
DO $$
DECLARE existing_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def
    FROM pg_constraint
   WHERE conname = 'Expense_projectId_fkey'
     AND conrelid = '"Expense"'::regclass;
  IF existing_def IS NULL THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  ELSIF existing_def NOT LIKE '%FOREIGN KEY ("projectId")%'
     OR existing_def NOT LIKE '%REFERENCES "Project"(id)%'
     OR existing_def NOT LIKE '%ON DELETE SET NULL%'
     OR existing_def NOT LIKE '%ON UPDATE CASCADE%' THEN
    RAISE EXCEPTION 'Expense_projectId_fkey already exists with an unexpected definition: %', existing_def;
  END IF;
END $$;

UPDATE "Expense" e SET "projectId" = est."projectId"
FROM "Estimate" est
WHERE e."estimateId" = est.id AND e."projectId" IS NULL AND est."projectId" IS NOT NULL;

-- ReceiptIntake is Phase 1's table. The guard keeps this runnable in EITHER
-- merge order: if Phase 1 has not landed in the target database yet, these two
-- columns are skipped and Phase 1's own migration creates the table without
-- them, at which point re-running this script adds them.
DO $$ BEGIN
  IF to_regclass('"ReceiptIntake"') IS NOT NULL THEN
    ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
  END IF;
END $$;
