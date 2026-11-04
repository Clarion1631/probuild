-- Multiple named contacts per job (lead or project). Additive only. Idempotent so
-- scripts/apply-job-contacts.mjs can run it on production before the deploy and
-- `migrate deploy`/CI can replay it on a fresh database.
CREATE TABLE IF NOT EXISTS "JobContact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "phoneE164" TEXT,
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "isPrimaryContact" BOOLEAN NOT NULL DEFAULT false,
    "roleNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobContact_leadId_idx" ON "JobContact"("leadId");

CREATE INDEX IF NOT EXISTS "JobContact_projectId_idx" ON "JobContact"("projectId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JobContact_leadId_fkey') THEN
    ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JobContact_projectId_fkey') THEN
    ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Same posture as the other newer tables: RLS on, no policies, so the Supabase
-- anon key cannot read contact names, emails or phones.
ALTER TABLE "JobContact" ENABLE ROW LEVEL SECURITY;
