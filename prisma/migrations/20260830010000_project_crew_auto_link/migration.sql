-- Provenance for crew connections made by the auto-assign sync
-- (crew-auto-assign-sync.ts), so it can tell "the sync added this" apart
-- from a manual Team Access connection and revoke ONLY what it added when a
-- user becomes ineligible (showOnDispatch -> false, leaves ACTIVATED, or
-- becomes FINANCE) or a project leaves the auto-assign statuses (In
-- Progress/Open/Active) -- and only when the user holds no TaskAssignment on
-- that project. Manual crew connections carry no row here and are never
-- touched. Additive, idempotent -- safe while the previous build is live.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProjectCrewAutoLink" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCrewAutoLink_pkey" PRIMARY KEY ("projectId", "userId")
);

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ProjectCrewAutoLink" ADD CONSTRAINT "ProjectCrewAutoLink_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ProjectCrewAutoLink" ADD CONSTRAINT "ProjectCrewAutoLink_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: every existing Project.crew pair that the sync would have
-- created itself -- an In Progress/Open/Active project, crewed by a user who
-- is currently dispatchable (showOnDispatch = true, ACTIVATED, role !=
-- FINANCE) -- gets an auto-link row so the revoke path can act on it. A
-- crew pair that predates the sync but doesn't match this shape (a manual
-- connection, or a currently-ineligible user) is deliberately left with no
-- row, i.e. treated as manual and never auto-revoked.
INSERT INTO "ProjectCrewAutoLink" ("projectId", "userId", "createdAt")
SELECT ca."A", ca."B", CURRENT_TIMESTAMP
FROM "_CrewAssignments" ca
JOIN "Project" p ON p."id" = ca."A"
JOIN "User" u ON u."id" = ca."B"
WHERE p."status" IN ('In Progress', 'Open', 'Active')
  AND u."showOnDispatch" = true
  AND u."status" = 'ACTIVATED'
  AND u."role" != 'FINANCE'
ON CONFLICT ("projectId", "userId") DO NOTHING;
