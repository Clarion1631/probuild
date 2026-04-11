-- Phase 1: Deduplicate leads with same (clientId, name)
-- Safety rules:
--   1. Never delete a lead that has a linked Project
--   2. Never delete a lead with estimates in status != 'Draft'
--   3. Keeper = lead with most child records; oldest if tied
--   4. Re-parent ALL child records before deleting
-- Wrapped in a transaction for atomicity

BEGIN;

-- Audit log table (temp, for this session)
CREATE TEMP TABLE dedup_audit (
  action TEXT,
  keeper_id TEXT,
  deleted_id TEXT,
  reason TEXT,
  ts TIMESTAMPTZ DEFAULT NOW()
);

-- For each group of leads sharing (clientId, name), pick the keeper
-- and re-parent / delete duplicates
DO $$
DECLARE
  rec RECORD;
  keeper_id TEXT;
  dup_id TEXT;
  child_count INT;
  keeper_count INT;
BEGIN
  FOR rec IN
    SELECT "clientId", name
    FROM "Lead"
    GROUP BY "clientId", name
    HAVING COUNT(*) > 1
  LOOP
    -- Pick keeper: most child records across all child tables, oldest if tied
    SELECT l.id INTO keeper_id
    FROM "Lead" l
    WHERE l."clientId" = rec."clientId" AND l.name = rec.name
    ORDER BY (
      (SELECT COUNT(*) FROM "Estimate"     WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "FloorPlan"    WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "Contract"     WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "ProjectFile"  WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "FileFolder"   WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "Takeoff"      WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "ScheduleTask" WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "LeadMessage"  WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "LeadNote"     WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "LeadTask"     WHERE "leadId" = l.id) +
      (SELECT COUNT(*) FROM "LeadMeeting"  WHERE "leadId" = l.id)
    ) DESC, l."createdAt" ASC
    LIMIT 1;

    -- Process each duplicate
    FOR dup_id IN
      SELECT id FROM "Lead"
      WHERE "clientId" = rec."clientId" AND name = rec.name AND id <> keeper_id
    LOOP
      -- Safety: skip if dup has a linked Project
      IF EXISTS (SELECT 1 FROM "Project" WHERE "leadId" = dup_id) THEN
        INSERT INTO dedup_audit VALUES ('SKIP', keeper_id, dup_id, 'has linked Project');
        CONTINUE;
      END IF;

      -- Safety: skip if dup has non-Draft estimates
      IF EXISTS (SELECT 1 FROM "Estimate" WHERE "leadId" = dup_id AND status <> 'Draft') THEN
        INSERT INTO dedup_audit VALUES ('SKIP', keeper_id, dup_id, 'has non-Draft estimate');
        CONTINUE;
      END IF;

      -- Re-parent all child records to keeper
      UPDATE "Estimate"     SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "FloorPlan"    SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "Contract"     SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "ProjectFile"  SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "FileFolder"   SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "Takeoff"      SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "ScheduleTask" SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "LeadMessage"  SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      -- LeadNote, LeadTask, LeadMeeting — cascade delete with their lead, no re-parent needed
      -- (lead-only activity stays with keeper if we want to keep it, move them too for safety)
      UPDATE "LeadNote"    SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "LeadTask"    SET "leadId" = keeper_id WHERE "leadId" = dup_id;
      UPDATE "LeadMeeting" SET "leadId" = keeper_id WHERE "leadId" = dup_id;

      INSERT INTO dedup_audit VALUES ('DELETE', keeper_id, dup_id, 're-parented all children');

      -- Delete the duplicate
      DELETE FROM "Lead" WHERE id = dup_id;
    END LOOP;
  END LOOP;
END;
$$;

-- Show audit log
SELECT * FROM dedup_audit ORDER BY ts;

-- Verify: no remaining duplicates
SELECT "clientId", name, COUNT(*) AS cnt
FROM "Lead"
GROUP BY "clientId", name
HAVING COUNT(*) > 1;

COMMIT;
