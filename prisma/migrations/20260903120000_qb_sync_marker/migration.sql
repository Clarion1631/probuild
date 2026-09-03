-- Round 38 gate, finding 5: /api/quickbooks/sync had no durable trace of an
-- in-flight document create, so a refresh after a 503 re-POSTed and QuickBooks
-- got a second estimate/invoice. These carry the same marker vocabulary the
-- milestone rail already uses (src/lib/qbo-create-markers.ts).
ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "qbSyncMarker" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "qbSyncMarker" TEXT;
