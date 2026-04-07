-- Workday exceptions settings
-- Adds support for company-level calendar overrides.

ALTER TABLE "CompanySettings"
ADD COLUMN IF NOT EXISTS "workdayExceptions" TEXT;
