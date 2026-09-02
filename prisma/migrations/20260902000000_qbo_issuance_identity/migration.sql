-- Per-issuance identity for a QuickBooks invoice send.
--
-- The idempotency key was derived from the row id, which is immutable — good
-- for de-duplicating a retry, but it also meant a milestone could NEVER be
-- re-issued: after an unlink, the next send reused the same key and Intuit
-- returned the ORIGINAL (deleted or stale) invoice instead of creating a new
-- one. A per-issuance key, minted before the first QBO call and cleared on
-- unlink, separates "this is the same attempt" from "this is a new issuance".
--
-- Additive and nullable: safe to apply while the old build is live.
ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbIssuanceKey" TEXT;
ALTER TABLE "ProgressBilling" ADD COLUMN IF NOT EXISTS "qbIssuanceKey" TEXT;
