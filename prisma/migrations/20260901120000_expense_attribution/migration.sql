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
-- THE SOURCE DOCUMENT'S OWN IDENTITY, AND WHICH GROUP OF IT THIS ROW IS.
-- The Drive ingest deduped on `receiptUrl LIKE '%' || fileId || '%'` while
-- storing a CALLER-SUPPLIED url: a payload whose `fileUrl` omitted the id
-- deduped against nothing and re-booked the receipt on every delivery, and the
-- substring match conflated a file id that is a prefix of another. The id is
-- now its own column, compared by equality. `sourceGroupIndex` is the group
-- ordinal within that document, because one receipt becomes one Expense per
-- category group and the file id alone is not a per-row identity.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "sourceFileId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "sourceGroupIndex" INTEGER;
-- Mixed receipts: the portion actually resold, when it is less than the whole
-- pre-tax total. NULL means "all of it", and is only reached on a row a human
-- has explicitly flagged installed-at-customer.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxDeductibleBase" DECIMAL(65,30);
-- Set when a re-sync invalidated a human tax classification (see the sync).
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "needsTaxReview" BOOLEAN NOT NULL DEFAULT false;
-- WHO decided the tax fields: "ocr" or "manual". A manual decision includes
-- "there is no tax here", which is a NULL taxAmount and so cannot be told from
-- "nobody has looked" without this column. Booking never overwrites "manual".
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxSource" TEXT;
-- WHO decided the deduction BASE, which is not the same question and not
-- always the same answer. A base-only PATCH deliberately leaves `taxSource`
-- alone so a later OCR read may still fill `taxAmount`; booking then stamps
-- `taxSource = 'ocr'` for the tax it filled, and while one column governed
-- both figures that made the row claim a machine had decided a base a person
-- had typed. Per-field provenance makes the mixed state representable.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxDeductibleBaseSource" TEXT;
-- THE CONSERVATIVE READING OF THE ROWS THAT PREDATE THE COLUMN. Before this
-- split, a human-entered base could only exist on a row a human had also
-- spoken to about tax, so a non-NULL base beside a human `taxSource` was
-- necessarily a human base. Marking it as such is what stops the next booking
-- pass from being able to claim it. Rows with an OCR or absent `taxSource`
-- are left NULL: nobody wrote a base on them, and inventing a provenance is
-- how a guess becomes a fact. Idempotent by the IS NULL predicate.
UPDATE "Expense"
   SET "taxDeductibleBaseSource" = 'manual'
 WHERE "taxDeductibleBaseSource" IS NULL
   AND "taxDeductibleBase" IS NOT NULL
   AND "taxSource" IN ('manual', 'manual-none');
-- The re-anchor marker. See the UPDATE the rollout script runs: a predicate on
-- the time-of-day cannot tell a row that has already been re-anchored from one
-- legitimately written at local midnight, so the fact is recorded.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attributionAnchoredAt" TIMESTAMP(3);

-- A ROW VERSION FOR THE TAX CORRECTION PATH (Codex round 9, item 2).
--
-- Nullable, backfilled, DEFAULT, then NOT NULL — in that order, and the DEFAULT
-- is not optional.
--
-- This script runs against production BEFORE the build that knows about the
-- column. For that window the OLD app is still inserting Expenses without it,
-- and a NOT NULL column with no default would fail every one of those inserts:
-- receipts, manual entries, the QBO sync. `now()` is what keeps the old code
-- writing while the new column exists. Prisma declares the same default
-- (`@default(now()) @updatedAt`), so CI's "migrations reproduce production"
-- check still sees the two agree.
--
-- Every statement is independently re-runnable: IF NOT EXISTS, a
-- predicate-bound UPDATE, and two ALTERs that are no-ops once applied.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT now();
ALTER TABLE "Expense" ALTER COLUMN "updatedAt" SET DEFAULT now();
UPDATE "Expense" SET "updatedAt" = COALESCE("createdAt", now()) WHERE "updatedAt" IS NULL;
ALTER TABLE "Expense" ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "Expense_projectId_idx" ON "Expense"("projectId");
CREATE INDEX IF NOT EXISTS "Expense_sourceFileId_idx" ON "Expense"("sourceFileId");

-- THE DURABLE BACKSTOP FOR THE INGEST LOCK.
--
-- The advisory lock in the ingest route serialises two concurrent deliveries of
-- one Drive file, but an advisory lock is not a constraint: a writer that does
-- not take it (a script, a future route) can still insert a second copy. This
-- index makes the duplicate unrepresentable for every row written by the new
-- ingest, which stamps both columns on every group.
--
-- PARTIAL, and NULLS-DISTINCT, both deliberately. `sourceFileId IS NOT NULL`
-- keeps every expense that did not come from a Drive document (manual entries,
-- the QBO import) out of it entirely. And rows backfilled from `receiptUrl`
-- above have a NULL `sourceGroupIndex` — nothing can say which group they
-- were — so a btree unique index treats them as distinct and the backfill
-- cannot collide with itself. Those legacy rows are therefore NOT protected by
-- this index; they are covered by the file-level dedupe, which is what makes a
-- re-delivery idempotent.
--
-- Prisma cannot express a partial index, so this is SQL-only and recorded in
-- prisma/prisma-blind-spots.json (same treatment as
-- BankImage_driveFileId_key); scripts/check-migrations-match.mjs asserts it.
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_sourceFileId_sourceGroupIndex_key"
  ON "Expense"("sourceFileId", "sourceGroupIndex")
  WHERE "sourceFileId" IS NOT NULL;

-- SET NULL, not Cascade: `estimateId` already owns this row's lifecycle. A
-- project delete must not silently destroy spend history that the estimate
-- still holds.
--
-- Guarded on the DEFINITION, not just the name (Codex round 1, issue 9). A
-- name-only `IF NOT EXISTS` silently accepts a pre-existing constraint of the
-- same name that points somewhere else or carries ON DELETE CASCADE — which is
-- precisely the failure this constraint exists to prevent. Existing-and-wrong
-- raises instead of being skipped: an operator has to look at it.
--
-- LOCK THE PARENT FIRST, AS ITS OWN STATEMENT, AND ADD NOT VALID (Codex round
-- 15, item 1). `ALTER TABLE "Expense" ADD CONSTRAINT ... REFERENCES
-- "Project"` locks the table NAMED in the ALTER TABLE clause (Expense, ACCESS
-- EXCLUSIVE) before it locks the REFERENCED table (Project, SHARE ROW
-- EXCLUSIVE, needed even for NOT VALID to install the FK's enforcement
-- trigger) — Expense before its own parent, backwards from every writer's
-- lockAttributionParents order. Locks are cumulative within a transaction and
-- never downgraded, so taking the Project lock first, as its own preceding
-- statement, makes the ADD CONSTRAINT statement's own request for the same
-- lock a no-op and the OBSERVED order becomes Project-then-Expense. See
-- scripts/apply-expense-attribution.mjs (PROJECT_FK_LOCK_STATEMENTS /
-- PROJECT_FK_VALIDATE_STATEMENTS) for the two-transaction split production
-- gets; this file stays one transaction (a Prisma requirement) but keeps the
-- SAME order — lock, then alter, then validate.
LOCK TABLE "Project" IN SHARE ROW EXCLUSIVE MODE;
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
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  ELSIF existing_def NOT LIKE '%FOREIGN KEY ("projectId")%'
     OR existing_def NOT LIKE '%REFERENCES "Project"(id)%'
     OR existing_def NOT LIKE '%ON DELETE SET NULL%'
     OR existing_def NOT LIKE '%ON UPDATE CASCADE%' THEN
    RAISE EXCEPTION 'Expense_projectId_fkey already exists with an unexpected definition: %', existing_def;
  END IF;
END $$;
ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_projectId_fkey";

-- TAX POINTS THE SAME WAY AS THE MONEY, AND IS NEVER BIGGER THAN IT
-- (Codex round 6 item 2; signed amounts, round 16 item 3).
--
-- The deduction base is `amount - taxAmount`, so a tax larger than the gross
-- makes it NEGATIVE and the report subtracts money from the filing. The
-- taxDeductibleBase CHECK below does not cover it: a row whose allocation is
-- NULL has no allocation to violate, and the negative base is computed at read
-- time. This closes that hole at the only place both values are always visible.
--
-- `Expense.amount` is SIGNED: a refund, return or vendor credit is a negative
-- expense and its tax comes back with it (-$50 with -$4 of tax). The first
-- version of this constraint said `taxAmount >= 0 AND taxAmount <= amount`,
-- which refused every one of those rows and would have pushed a bookkeeper into
-- recording a credit as a positive — a filing that ADDS what it should subtract.
--
-- Dropped and re-added rather than guarded on existence, so a database that
-- already carries the old definition is corrected rather than skipped. Both
-- statements are re-runnable.
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxAmount_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxAmount_check"
  CHECK ("taxAmount" IS NULL
         OR "taxAmount" = 0
         OR (sign("taxAmount") = sign("amount") AND abs("taxAmount") <= abs("amount")));

-- THE DEDUCTION INVARIANT, IN THE DATABASE (Codex round 5, item 4).
--
-- `0 <= taxDeductibleBase <= amount - taxAmount` was enforced only by the API
-- handler that writes it: read the amount, validate, then UPDATE. A QBO re-sync
-- changing `amount` between those two statements leaves a row the tax report
-- deliberately TRUSTS — it claims the allocated base verbatim — so an
-- impossible row becomes an overstated deduction on a state return.
--
-- Prisma cannot express a CHECK, so this lives here by hand and is recorded in
-- prisma/prisma-blind-spots.json; scripts/check-migrations-match.mjs asserts it.
-- Safe to add: `taxDeductibleBase` is new and every existing row is NULL.
-- SIGNED, for the same reason the tax check is: a return or vendor credit is a
-- negative expense, and the resold portion of it is negative too. `base >= 0`
-- made every credit unallocatable, which is the shape that pushes a bookkeeper
-- into recording it as a positive and ADDING to a filing that should shrink.
--
-- Dropped and re-added by name, so a database carrying the unsigned definition
-- is corrected rather than skipped. Both statements are re-runnable.
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxDeductibleBase_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxDeductibleBase_check"
  CHECK ("taxDeductibleBase" IS NULL
         OR "taxDeductibleBase" = 0
         OR (sign("taxDeductibleBase") = sign("amount")
             AND abs("taxDeductibleBase") <= abs("amount" - COALESCE("taxAmount", 0))));

-- `taxAtSource` IS DERIVED, AND THE DATABASE SAYS SO (round 20, item 1).
--
-- "Tax was charged on this receipt" is true exactly when the row carries a tax
-- figure. It was a second, independently writable column saying the same thing,
-- so the two could disagree — `taxAtSource: true` with no amount is a claim
-- about nothing, and `false` with $16.55 on the row is a deduction silently
-- dropped from the excise return. Every writer now derives it; this makes a
-- disagreement unrepresentable rather than merely uncommon.
--
-- NORMALISED FIRST, then constrained: a CHECK cannot be added to a table that
-- already violates it, and both statements are re-runnable.
UPDATE "Expense"
   SET "taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)
 WHERE "taxAtSource" <> ("taxAmount" IS NOT NULL AND "taxAmount" <> 0);
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxAtSource_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxAtSource_check"
  CHECK ("taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0));

-- THE ROLLOUT-WINDOW GUARD (round 36, item 1). Created BEFORE the backfill
-- below, because the damage happens between them: once `projectId` carries
-- values, an OLD app instance whose Prisma client predates that column can
-- still rewrite `estimateId` (its QBO sync writes the whole record), leaving
-- the row on job A by projectId and job B by estimate.
--
-- It fires ONLY when the UPDATE leaves `projectId` untouched, which is exactly
-- the old build and exactly nothing in the new one.
--
-- CORRECTION (round 42, item 4a): an earlier version of this note said a
-- bookkeeper re-attributing an expense KEEPS the estimate of the job it left,
-- "on purpose". That was never a defensible resting state -- it is the
-- split-job row this whole migration exists to prevent, entered deliberately,
-- and until round 42 the abandoned estimate could also DELETE the spend on its
-- way out (Expense_estimateId_fkey was ON DELETE CASCADE). Re-attribution moves
-- BOTH halves, through `reattributeExpense` in src/lib/expense-attribution.ts,
-- which resolves the target job's own estimate or leaves `estimateId` NULL when
-- that job has none. No handler offers re-attribution today; the helper and the
-- tripwire in tests/attribution-lock-order.test.ts exist so the path that gets
-- built next is the correct one. What this trigger still protects is the OLD
-- BUILD's `estimateId`-only rewrite, which is a different thing entirely,
-- and this must never revert that.
--
-- Dropped again at the end of this file: it is compatibility scaffolding for
-- one deploy, not a standing invariant. In production the drop is the
-- --post-deploy pass (see scripts/apply-expense-attribution.mjs); here the two
-- run back to back, so a database built from these migrations ends in the same
-- shape production ends in — with no trigger.
CREATE OR REPLACE FUNCTION probuild_expense_estimate_pair_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
    est_project TEXT;
BEGIN
    IF NEW."estimateId" IS DISTINCT FROM OLD."estimateId"
       AND NEW."projectId" IS NOT DISTINCT FROM OLD."projectId"
       AND OLD."projectId" IS NOT NULL
       AND NEW."estimateId" IS NOT NULL
    THEN
        -- LOCKED, NOT A PLAIN READ (Codex round 15, item 3). See the same
        -- comment in scripts/apply-expense-attribution.mjs.
        SELECT est."projectId" INTO est_project
          FROM "Estimate" est
         WHERE est.id = NEW."estimateId"
           FOR KEY SHARE;
        IF est_project IS NOT NULL THEN
            NEW."projectId" := est_project;
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS probuild_expense_estimate_pair_guard ON "Expense";

CREATE TRIGGER probuild_expense_estimate_pair_guard
BEFORE UPDATE OF "estimateId" ON "Expense"
FOR EACH ROW
EXECUTE FUNCTION probuild_expense_estimate_pair_guard();


-- ...AND THE SAME WINDOW, POINTED AT THE TAX FIGURES (round 37, item 2).
--
-- The guard above protects the attribution pair and nothing else. The OLD
-- build's QBO sync writes the whole expense record, `amount` included, with a
-- Prisma client that predates every tax column -- so during the drain window
-- it can move the gross under a tax classification it cannot see. The stale
-- figures stay reportable without review, and if the new gross is smaller than
-- the recorded tax (or leaves the deduction base above `amount - taxAmount`)
-- the row violates a CHECK added above and the old sync simply fails.
--
-- This trigger re-applies the NEW build's own rules to any statement that
-- moves the gross: it is a transcription of planExpenseUpdate
-- (src/lib/qbo-expense-sync.ts), branch for branch, which is what makes it
-- safe to leave firing while the new build is also serving -- that build has
-- already computed these values, so the trigger recomputes the same answer.
-- It never invents a figure: a figure that no longer fits is CLEARED, with
-- the provenance that described it, and the row is flagged for review.
--
-- Dropped again at the end of this file, like the guard above: in production
-- the drop is the --post-deploy pass; here the two run back to back so a
-- database built from these migrations ends in production's END state.
CREATE OR REPLACE FUNCTION probuild_expense_amount_tax_ack()
RETURNS trigger
LANGUAGE plpgsql
AS $ack$
BEGIN
    PERFORM set_config(
        'probuild.tax_flag_stated',
        NEW."id" || '@' || statement_timestamp()::text,
        true
    );
    RETURN NEW;
END;
$ack$;

DROP TRIGGER IF EXISTS probuild_expense_amount_tax_ack ON "Expense";

CREATE TRIGGER probuild_expense_amount_tax_ack
BEFORE UPDATE OF "needsTaxReview" ON "Expense"
FOR EACH ROW
EXECUTE FUNCTION probuild_expense_amount_tax_ack();

CREATE OR REPLACE FUNCTION probuild_expense_amount_tax_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
    base_ceiling NUMERIC;
    was_classified BOOLEAN;
BEGIN
    IF NEW."amount" IS NOT DISTINCT FROM OLD."amount" OR NEW."amount" IS NULL THEN
        RETURN NEW;
    END IF;

    -- Did this row carry a tax answer BEFORE the write? Read off OLD, the
    -- same way planExpenseUpdate reads it off the stored row.
    --
    -- The columns, and how each KIND is read, are
    -- TAX_CLASSIFICATION_FIGURE_COLUMNS and
    -- TAX_CLASSIFICATION_SOURCE_COLUMNS in
    -- src/lib/expense-attribution.ts -- the ONE definition the QBO sync
    -- and the expense PUT handler both read too, and the shape of this
    -- expression is pinned against those constants in
    -- tests/apply-expense-attribution.test.ts. A FIGURE counts whenever
    -- it is present at all; a PROVENANCE counts only when it is a HUMAN
    -- one, because a machine guess with no surviving figure has nothing
    -- left to invalidate. Deciding that differently in each writer was
    -- how the three drifted apart in the first place.
    was_classified :=
        OLD."taxAmount" IS NOT NULL
        OR OLD."taxDeductibleBase" IS NOT NULL
        OR OLD."installedAtCustomer" IS NOT NULL
        OR COALESCE(OLD."taxSource", '') IN ('manual', 'manual-none')
        OR COALESCE(OLD."taxDeductibleBaseSource", '') IN ('manual', 'manual-none');

    -- 1. The recorded tax cannot fit the new gross: it points the other
    --    way, or it is bigger. Everything the row claimed about tax goes,
    --    provenance included.
    IF NEW."taxAmount" IS NOT NULL
       AND NEW."taxAmount" <> 0
       AND (sign(NEW."taxAmount") <> sign(NEW."amount")
            OR abs(NEW."taxAmount") > abs(NEW."amount"))
    THEN
        NEW."taxAmount" := NULL;
        NEW."installedAtCustomer" := NULL;
        NEW."taxDeductibleBase" := NULL;
        NEW."taxDeductibleBaseSource" := NULL;
        NEW."taxSource" := NULL;
        NEW."needsTaxReview" := true;
    -- 2. The tax still fits, but the hand allocation no longer does.
    --    Clearing it silently would leave a row that still reads as a
    --    valid deduction of the WHOLE pre-tax total, so it is flagged.
    ELSIF NEW."taxDeductibleBase" IS NOT NULL AND NEW."taxDeductibleBase" <> 0 THEN
        base_ceiling := NEW."amount" - COALESCE(NEW."taxAmount", 0);
        IF sign(NEW."taxDeductibleBase") <> sign(base_ceiling)
           OR abs(NEW."taxDeductibleBase") > abs(base_ceiling)
        THEN
            NEW."taxDeductibleBase" := NULL;
            NEW."taxDeductibleBaseSource" := NULL;
            NEW."needsTaxReview" := true;
        END IF;
    END IF;

    -- 3. ANY movement in the gross re-opens a classification that survived
    --    the two branches above. The numbers still satisfy every CHECK,
    --    which is exactly why nothing else would ever ask.
    --
    --    UNLESS THE STATEMENT SPOKE FOR ITSELF (round 41, item 3). This
    --    used to be unconditional, and it defeated a valid
    --    taxReviewAck: the PUT decided the row was certified, omitted
    --    the flag, and this line put it straight back -- so for the whole
    --    drain window an acknowledged edit was still excluded from the
    --    filing and queued for a review that had already happened.
    --
    --    The exemption is "this UPDATE named needsTaxReview in its SET
    --    list", which is EXACTLY what the old build can never do: its
    --    Prisma client predates the column. The companion trigger
    --    probuild_expense_amount_tax_ack is declared BEFORE UPDATE OF
    --    "needsTaxReview", so it fires only for a statement that names it,
    --    and it fires FIRST because BEFORE ROW triggers run in name order
    --    and 'ack' sorts before 'guard'. The marker carries the row id AND
    --    statement_timestamp(), so it can only ever exempt the row and the
    --    statement that set it -- a later statement in the same
    --    transaction has a different timestamp and is judged on its own.
    IF was_classified
       AND COALESCE(current_setting('probuild.tax_flag_stated', true), '')
           IS DISTINCT FROM NEW."id" || '@' || statement_timestamp()::text
    THEN
        NEW."needsTaxReview" := true;
    END IF;

    -- ...and the derived flag agrees with the figure, whatever happened.
    NEW."taxAtSource" := (NEW."taxAmount" IS NOT NULL AND NEW."taxAmount" <> 0);
    RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS probuild_expense_amount_tax_guard ON "Expense";

CREATE TRIGGER probuild_expense_amount_tax_guard
BEFORE UPDATE OF "amount" ON "Expense"
FOR EACH ROW
EXECUTE FUNCTION probuild_expense_amount_tax_guard();

-- THE DRAIN-WINDOW BRIDGE FOR DRIVE RECEIPTS (Codex round 48, item 1).
--
-- Old instances insert receipt rows with NULL sourceFileId/sourceGroupIndex,
-- because their Prisma client predates both columns. The new route dedupes on
-- sourceFileId, so it cannot see those rows and a retried delivery inserts the
-- whole receipt twice. This trigger stamps the id from receiptUrl on INSERT and
-- takes the SAME per-file advisory lock the route takes, so the two versions
-- serialize; the ordinal counts within the transaction, so a re-delivery lands
-- on the ordinals already there and the partial unique index refuses it.
--
-- It is the THIRD of three drain-window triggers (the split-job pair guard,
-- the amount/tax guard, this bridge): created here and
-- dropped at the end of this file, so a fresh database finishes in the shape
-- production finishes in.
CREATE OR REPLACE FUNCTION probuild_expense_source_file_bridge()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $bridge$
     DECLARE
         derived TEXT;
         next_index INT;
     BEGIN
         -- A row that already names its file speaks for itself: the new build
         -- inserted it, and it has chosen its own group ordinal.
         IF NEW."sourceFileId" IS NULL AND NEW."receiptUrl" IS NOT NULL THEN
             derived := COALESCE(
                 substring(NEW."receiptUrl" from '/d/([A-Za-z0-9_-]+)'),
                 substring(NEW."receiptUrl" from '[?&]id=([A-Za-z0-9_-]+)')
             );
             NEW."sourceFileId" := derived;
         END IF;

         -- AN IDENTITY THAT DOES NOT DEPEND ON PARSING THE URL (round 49,
         -- item 2).
         --
         -- This used to RETURN early when no id could be derived -- a
         -- shortened link, a re-hosted copy, a /uc?export=download form -- so
         -- the old instance's insert took no lock at all. The new route's
         -- exact-url fallback can see such a row only once it has COMMITTED;
         -- against an in-flight one it read "nothing here" and inserted the
         -- receipt again. The lock is what makes the two versions wait for
         -- each other, so it cannot be conditional on the url being
         -- parseable: when there is no file id, the normalised url IS the
         -- identity, and the route hashes the same string.
         --
         -- An insert with no receipt url at all is not a Drive receipt: no
         -- lock, no ordinal, nothing.
         IF NEW."sourceFileId" IS NULL AND NEW."receiptUrl" IS NULL THEN
             RETURN NEW;
         END IF;

         -- THE SAME LOCK THE ROUTE TAKES, so an old-version insert and a
         -- new-version request for one document cannot both believe they are
         -- first. Transaction-scoped: released at COMMIT or ROLLBACK, nothing
         -- to leak.
         IF NEW."sourceFileId" IS NOT NULL THEN
             PERFORM pg_advisory_xact_lock(
                 hashtextextended('receipt-ingest:' || NEW."sourceFileId", 0)
             );
         ELSE
             PERFORM pg_advisory_xact_lock(
                 hashtextextended('receipt-ingest-url:' || lower(btrim(NEW."receiptUrl")), 0)
             );
             -- No id means no ordinal: the unique index is partial on
             -- "sourceFileId" IS NOT NULL, so a number here would guard
             -- nothing and would invite a reader to treat it as a group
             -- position it cannot be. The row is still identified by its url,
             -- which is what the route matches it on.
             RETURN NEW;
         END IF;

         -- THE ORDINAL COUNTS WHAT IS COMMITTED, NOT WHAT THIS TRANSACTION
         -- HAS DONE (round 49, item 1 -- a P0 this replaces).
         --
         -- The first version counted per TRANSACTION, on the theory that a
         -- re-delivery would then collide with the rows already there and be
         -- refused. That theory assumed the old handler writes its groups in
         -- one transaction. It does not: the deployed handler calls
         -- prisma.expense.create() once per group, each its own autocommit
         -- statement (see the loop in the pre-Phase-3
         -- src/app/api/integrations/receipt-ingest/route.ts). So every group of
         -- one receipt got ordinal 0, group two violated the unique index the
         -- moment group one committed, and a retry -- seeing group one --
         -- answered alreadyIngested. The remaining groups were dropped for
         -- good: money silently missing from a receipt the archive says was
         -- imported.
         --
         -- MAX(committed) + 1, under the advisory lock above, is what the old
         -- handler's actual boundaries need: three autocommit inserts become
         -- 0, 1, 2 because each one sees its committed siblings.
         --
         -- WHAT THIS GIVES UP, said plainly: a re-delivery of a document that
         -- is already complete no longer collides -- it appends. That is the
         -- behaviour the old build has today with no bridge at all, and it is
         -- still guarded on both sides (the old handler's own url dedupe, and
         -- the new route's alreadyIngestedWhere). Losing groups is worse
         -- than a duplicate a human can see, and the resume path in the route
         -- is what makes the retry land the missing groups instead of nothing.
         IF NEW."sourceGroupIndex" IS NULL THEN
             SELECT COALESCE(MAX("sourceGroupIndex"), -1) + 1
               INTO next_index
               FROM "Expense"
              WHERE "sourceFileId" = NEW."sourceFileId";
             NEW."sourceGroupIndex" := next_index;
         END IF;

         RETURN NEW;
     END;
     $bridge$;

DROP TRIGGER IF EXISTS probuild_expense_source_file_bridge ON "Expense";

CREATE TRIGGER probuild_expense_source_file_bridge
     BEFORE INSERT ON "Expense"
     FOR EACH ROW
     EXECUTE FUNCTION probuild_expense_source_file_bridge();



-- THE BACKFILL READS THE ESTIMATE UNDER A LOCK (Codex round 32). A plain
-- `UPDATE ... FROM "Estimate"` join takes no row lock, so under READ COMMITTED
-- an estimate moved to another job right after the read leaves the expense
-- stamped with the job it has already left -- the split-job row this migration
-- exists to prevent, manufactured by the migration itself. The locked CTE is
-- ONE statement, so the rows written from are exactly the rows locked.
-- `ORDER BY est.id` keeps the same ascending-id acquisition order the app's
-- lockMoneyParentsMany uses, so this cannot deadlock against a live
-- transaction. Kept byte-identical in meaning to PROJECT_ID_BACKFILL in
-- scripts/apply-expense-attribution.mjs (asserted by
-- tests/apply-expense-attribution.test.ts).
-- AN ESTIMATE MAY NOT DELETE SPEND (round 42, item 4b).
--
-- `Expense_estimateId_fkey` was NOT NULL + ON DELETE CASCADE, so deleting an
-- estimate DELETED every expense booked through it. Phase 3 makes that worse:
-- a re-attributed row is reported under a DIFFERENT job (its own projectId)
-- while still hanging off the estimate it left, so tidying up a superseded
-- estimate silently destroys another job's cost -- money with a QuickBooks
-- Purchase behind it.
--
-- SET NULL, not RESTRICT: the row keeps projectId, which is the primary
-- attribution every reader already prefers, so the spend stays on its job with
-- no estimate behind it. RESTRICT would preserve the cost too, but it would
-- block deleting a PROJECT (Project cascades to its Estimates, and those
-- deletes would then be refused); Invoice.estimateId and Takeoff.estimateId
-- already take the SET NULL stance in this schema.
--
-- The column has to become nullable first, or SET NULL is unenforceable.
ALTER TABLE "Expense" ALTER COLUMN "estimateId" DROP NOT NULL;

-- LOCK THE PARENT FIRST, AS ITS OWN STATEMENT, AND ADD NOT VALID (Codex round
-- 15, item 1) — same reasoning as the Project FK above, pointed at Estimate.
LOCK TABLE "Estimate" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE existing_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def
    FROM pg_constraint
   WHERE conname = 'Expense_estimateId_fkey'
     AND conrelid = '"Expense"'::regclass;
  IF existing_def IS NULL THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  ELSIF existing_def NOT LIKE '%ON DELETE SET NULL%' THEN
    ALTER TABLE "Expense" DROP CONSTRAINT "Expense_estimateId_fkey";
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;
ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_estimateId_fkey";

DO $$ BEGIN
  IF to_regclass('"ReceiptIntake"') IS NOT NULL THEN
    ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
    -- "user" | "machine": who supplied the captured phase. Booking copies the
    -- distinction onto the Expense so an automated pass may correct a machine's
    -- guess and may never touch a person's answer.
    ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT;
  END IF;
END $$;

-- ================= PHASE B: THE DATA =================
--
-- Everything above is SHAPE. In production these two halves run as TWO
-- SEPARATE TRANSACTIONS (scripts/apply-expense-attribution.mjs, round 44,
-- item 1): the first ALTER TABLE takes ACCESS EXCLUSIVE on Expense and holds
-- it to COMMIT, so taking Project and Estimate row locks in that same
-- transaction is the other half of a cycle with any concurrent estimate move.
-- Phase A commits and releases the table; phase B then takes the parents.
--
-- This FILE is replayed by Prisma inside ONE transaction and there is no
-- supported way to split one. That costs nothing: a migration only ever runs
-- against a fresh CI or dev database where nothing else is writing. What the
-- file must get right is the ORDER, which is why the statements are grouped
-- this way rather than interleaved.

-- THE JOBS FIRST (round 41, item 1). The UPDATE below is not the
-- estimate-only statement it looks like: the foreign key added by this same
-- migration makes Postgres take FOR KEY SHARE on every referenced Project row
-- to enforce it, so its real order is Estimate -> Project. A job editor
-- holding its Project row FOR UPDATE while reaching for an estimate closes the
-- cycle, and Postgres breaks it with 40P01 -- which here means the whole
-- migration transaction, not one row.
--
-- A separate STATEMENT rather than another CTE, because CTE evaluation order
-- is not guaranteed and "lock the projects in an earlier CTE" would be a hope
-- rather than a rule. Two statements in one transaction have a defined order,
-- and the first one's locks are held for the second. Kept byte-identical in
-- meaning to PROJECT_ID_BACKFILL_LOCK_PROJECTS in
-- scripts/apply-expense-attribution.mjs (asserted by
-- tests/apply-expense-attribution.test.ts).
SELECT p.id
  FROM "Project" p
 WHERE p.id IN (
       SELECT DISTINCT est."projectId"
         FROM "Estimate" est
        WHERE est."projectId" IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM "Expense" e
                 WHERE e."estimateId" = est.id AND e."projectId" IS NULL
              )
     )
 ORDER BY p.id
   FOR SHARE;

WITH locked AS (
  SELECT est.id, est."projectId"
    FROM "Estimate" est
   WHERE est."projectId" IS NOT NULL
     AND EXISTS (
           SELECT 1 FROM "Expense" e
            WHERE e."estimateId" = est.id AND e."projectId" IS NULL
         )
   ORDER BY est.id
     FOR SHARE
)
UPDATE "Expense" e SET "projectId" = locked."projectId"
  FROM locked
 WHERE e."estimateId" = locked.id AND e."projectId" IS NULL;

-- BACKFILL FROM THE URL, BUT ONLY WHERE THE ID IS UNAMBIGUOUS. Both shapes the
-- app has ever produced carry it (`/d/<id>` and `id=<id>`); anything else is
-- left NULL rather than guessed, since a wrong id would dedupe two unrelated
-- documents together. Idempotent by the IS NULL predicate.
UPDATE "Expense"
   SET "sourceFileId" = COALESCE(
         substring("receiptUrl" from '/d/([A-Za-z0-9_-]+)'),
         substring("receiptUrl" from '[?&]id=([A-Za-z0-9_-]+)')
       )
 WHERE "sourceFileId" IS NULL
   AND COALESCE(
         substring("receiptUrl" from '/d/([A-Za-z0-9_-]+)'),
         substring("receiptUrl" from '[?&]id=([A-Za-z0-9_-]+)')
       ) IS NOT NULL;

-- ReceiptIntake is Phase 1's table. The guard keeps this runnable in EITHER
-- merge order: if Phase 1 has not landed in the target database yet, these two
-- columns are skipped and Phase 1's own migration creates the table without
-- them, at which point re-running this script adds them.

-- ...and the guard comes back out. In production this half is the
-- --post-deploy pass, run once the old instances have drained; here it runs
-- immediately, so a fresh database matches production's END state rather than
-- its mid-deploy one. Left standing, the trigger would quietly overrule any
-- future writer that legitimately moves an estimate without restating the job.
DROP TRIGGER IF EXISTS probuild_expense_estimate_pair_guard ON "Expense";
DROP FUNCTION IF EXISTS probuild_expense_estimate_pair_guard();
DROP TRIGGER IF EXISTS probuild_expense_amount_tax_guard ON "Expense";
DROP FUNCTION IF EXISTS probuild_expense_amount_tax_guard();
DROP TRIGGER IF EXISTS probuild_expense_amount_tax_ack ON "Expense";
DROP FUNCTION IF EXISTS probuild_expense_amount_tax_ack();

-- ...and the bridge comes out with them. It is the most expensive of the
-- three to leave standing: an advisory lock on every expense insert that
-- carries a Drive url, forever.
DROP TRIGGER IF EXISTS probuild_expense_source_file_bridge ON "Expense";
DROP FUNCTION IF EXISTS probuild_expense_source_file_bridge();
