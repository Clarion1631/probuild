-- Reverse booking (admin only) closes a receipt row in a new terminal state,
-- REVERSED. It is deliberately NOT DUPLICATE/VOID: the partial unique index on
-- dedupStrongKey excludes only those two, so a REVERSED row keeps its key and a
-- re-sent copy of the same file is stopped instead of booking again.
--
-- The state CHECK is a closed set, so it has to learn the new value. Additive
-- and idempotent: compares the definition and replaces it only when it differs
-- (the same convergence the original receipt_intake migration uses). The new
-- CHECK is validated against existing rows by the ADD itself; every current
-- state is still in the set, so it cannot fail on live data.
DO $$
DECLARE
    current_def TEXT;
    wanted_def  TEXT := 'CHECK ((state = ANY (ARRAY[''STAGING''::text, ''RECEIVED''::text, ''READ''::text, ''NEEDS_JOB''::text, ''NEEDS_REVIEW''::text, ''BOOKING''::text, ''BOOKED''::text, ''ARCHIVED''::text, ''DUPLICATE''::text, ''VOID''::text, ''NON_RECEIPT''::text, ''REVERSED''::text, ''SHADOW_DONE''::text, ''SHADOW_QUARANTINE''::text])))';
BEGIN
    SELECT pg_get_constraintdef(oid) INTO current_def
      FROM pg_constraint
     WHERE conname = 'ReceiptIntake_state_check'
       AND conrelid = '"ReceiptIntake"'::regclass;

    IF current_def IS DISTINCT FROM wanted_def THEN
        IF current_def IS NOT NULL THEN
            ALTER TABLE "ReceiptIntake" DROP CONSTRAINT "ReceiptIntake_state_check";
        END IF;
        ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
            CHECK ("state" IN ('STAGING', 'RECEIVED', 'READ', 'NEEDS_JOB', 'NEEDS_REVIEW', 'BOOKING',
                               'BOOKED', 'ARCHIVED', 'DUPLICATE', 'VOID', 'NON_RECEIPT', 'REVERSED',
                               'SHADOW_DONE', 'SHADOW_QUARANTINE'));
    END IF;
END $$;
