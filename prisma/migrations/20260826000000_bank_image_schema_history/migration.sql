-- BankImage schema history. These tables were first applied through the guarded
-- rollout script scripts/apply-bank-image.mjs. Keep this migration additive and
-- idempotent so a production database that already has the reviewed rollout is
-- untouched, while a fresh migration history reproduces the Prisma schema.

CREATE TABLE IF NOT EXISTS "BankImage" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceExternalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "documentDate" DATE,
    "driveFileId" TEXT,
    "fileName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "byteSize" INTEGER,
    "normalizedCheckNumber" TEXT,
    "amountCents" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankImage_source_sourceExternalId_key"
    ON "BankImage" ("source", "sourceExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "BankImage_driveFileId_key"
    ON "BankImage" ("driveFileId") WHERE "driveFileId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "BankImage_kind_capturedAt_idx"
    ON "BankImage" ("kind", "capturedAt");
CREATE INDEX IF NOT EXISTS "BankImage_kind_normalizedCheckNumber_idx"
    ON "BankImage" ("kind", "normalizedCheckNumber");
CREATE INDEX IF NOT EXISTS "BankImage_account_documentDate_idx"
    ON "BankImage" ("account", "documentDate");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_kind_check') THEN
        ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_kind_check"
            CHECK ("kind" IN ('CHECK_FRONT', 'CHECK_BACK', 'DEPOSIT_SLIP', 'DEPOSIT_PHOTO'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_amountCents_check') THEN
        ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_amountCents_check"
            CHECK ("amountCents" IS NULL OR "amountCents" >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_check_number_shape') THEN
        ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_check_number_shape"
            CHECK (
                ("kind" IN ('CHECK_FRONT', 'CHECK_BACK') AND "normalizedCheckNumber" IS NOT NULL)
                OR ("kind" IN ('DEPOSIT_SLIP', 'DEPOSIT_PHOTO') AND "normalizedCheckNumber" IS NULL)
            );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BankImageMatch" (
    "id" TEXT NOT NULL,
    "bankImageId" TEXT NOT NULL,
    "bankLineId" TEXT,
    "qbType" TEXT,
    "qbTxnId" TEXT,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "BankImageMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankImageMatch_bankImageId_key"
    ON "BankImageMatch" ("bankImageId");
CREATE INDEX IF NOT EXISTS "BankImageMatch_bankLineId_idx"
    ON "BankImageMatch" ("bankLineId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'BankImageMatch_bankImageId_fkey'
          AND conrelid = '"BankImageMatch"'::regclass
    ) THEN
        ALTER TABLE "BankImageMatch"
            ADD CONSTRAINT "BankImageMatch_bankImageId_fkey"
            FOREIGN KEY ("bankImageId") REFERENCES "BankImage"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'BankImageMatch_bankLineId_fkey'
          AND conrelid = '"BankImageMatch"'::regclass
    ) THEN
        ALTER TABLE "BankImageMatch"
            ADD CONSTRAINT "BankImageMatch_bankLineId_fkey"
            FOREIGN KEY ("bankLineId") REFERENCES "BankLine"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImageMatch_target_present') THEN
        ALTER TABLE "BankImageMatch" ADD CONSTRAINT "BankImageMatch_target_present"
            CHECK ("bankLineId" IS NOT NULL OR "qbTxnId" IS NOT NULL);
    END IF;
END $$;
