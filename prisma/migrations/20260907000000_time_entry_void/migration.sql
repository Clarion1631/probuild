ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(6);
-- statement-break
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "voidedById" TEXT;
-- statement-break
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

-- statement-break
DO $$ BEGIN
IF EXISTS (SELECT 1 FROM "TimeEntry" WHERE "endTime" IS NULL AND "durationHours" IS NULL AND "voidedAt" IS NULL GROUP BY "userId" HAVING count(*) > 1) THEN
  RAISE EXCEPTION 'Existing duplicate open punches require reviewed correction before void migration';
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TimeEntry_void_metadata_complete' AND conrelid = '"TimeEntry"'::regclass) THEN
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_void_metadata_complete" CHECK (
  ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
  OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) BETWEEN 1 AND 1000)
);
END IF;
END $$;

-- Replace the stricter old predicate atomically. A retained voided open punch
-- must not block its owner, and two nonvoid open punches must remain impossible.
-- statement-break
DROP INDEX IF EXISTS "TimeEntry_one_open_per_user";
-- statement-break
CREATE UNIQUE INDEX "TimeEntry_one_open_per_user" ON "TimeEntry"("userId") WHERE "endTime" IS NULL AND "durationHours" IS NULL AND "voidedAt" IS NULL;

-- statement-break
CREATE OR REPLACE FUNCTION preserve_voided_time_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TIME_ENTRY_VOIDED: retained voided evidence is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."voidedAt" IS NOT NULL AND
    (to_jsonb(NEW) - ARRAY['voidedAt','voidedById','voidReason','updatedAt']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['voidedAt','voidedById','voidReason','updatedAt']) THEN
    RAISE EXCEPTION 'TIME_ENTRY_VOIDED: void cannot alter source punches or money';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
-- statement-break
DROP TRIGGER IF EXISTS "TimeEntry_preserve_voided" ON "TimeEntry";
-- statement-break
CREATE TRIGGER "TimeEntry_preserve_voided" BEFORE UPDATE OR DELETE ON "TimeEntry" FOR EACH ROW EXECUTE FUNCTION preserve_voided_time_entry();
