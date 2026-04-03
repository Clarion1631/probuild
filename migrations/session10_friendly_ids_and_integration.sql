-- Session 10: Friendly numeric IDs + Integration settings storage
-- Run via: powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"
-- After running: ./node_modules/.bin/prisma generate
--
-- These are purely ADDITIVE (new nullable columns). Existing queries are unaffected.
-- New columns show up immediately after migration — no data backfill needed for display.

-- Friendly numeric IDs (auto-increment, unique)
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "number" SERIAL;

-- Integration token storage on CompanySettings (single-tenant JSON blob)
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "integrationData" TEXT;
-- integrationData JSON structure:
-- {
--   "quickbooks": { "accessToken": "...", "refreshToken": "...", "realmId": "...", "connectedAt": "...", "glMappings": {...} },
--   "gusto": { "accessToken": "...", "refreshToken": "...", "companyId": "...", "employeeMappings": {...} }
-- }

-- GL Account mappings are stored inside integrationData.quickbooks.glMappings
-- Structure: { "costCodeId": "QB_GL_Account_Name", ... }

-- Gusto employee mappings are stored inside integrationData.gusto.employeeMappings
-- Structure: { "userId": "gusto_employee_id", ... }
