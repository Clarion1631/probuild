ALTER TABLE "ReceiptMemoArtifact" ADD COLUMN IF NOT EXISTS "pdfSha256" TEXT;
ALTER TABLE "ReceiptMemoArtifact" ADD COLUMN IF NOT EXISTS "provenanceJson" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_pdfSha256_key" ON "ReceiptMemoArtifact" ("pdfSha256");
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ReceiptMemoArtifact_pdfSha256_hex_check' AND conrelid='"ReceiptMemoArtifact"'::regclass) THEN
 ALTER TABLE "ReceiptMemoArtifact" ADD CONSTRAINT "ReceiptMemoArtifact_pdfSha256_hex_check" CHECK ("pdfSha256" IS NULL OR "pdfSha256" ~ '^[0-9a-f]{64}$');
 END IF;
END $$;
