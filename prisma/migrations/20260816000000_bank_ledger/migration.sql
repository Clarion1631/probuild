-- Bank Ledger persistence model. Prisma-visible DDL was generated with Prisma
-- 5.22.0 from the two preceding migrations; the tail preserves the catalog
-- objects Prisma cannot render (CHECKs, partial index, RLS, functions, and
-- triggers) from the reviewed one-off rollout script.

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "openingCents" INTEGER NOT NULL,
    "closingCents" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FINALIZED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLine" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "postedDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "rawDescriptor" TEXT NOT NULL,
    "normalizedPayee" TEXT NOT NULL,
    "checkNumber" TEXT,
    "state" TEXT NOT NULL DEFAULT 'POSTED',
    "exceptionReason" TEXT,
    "qbTxnId" TEXT,
    "qbBankMatched" BOOLEAN NOT NULL DEFAULT false,
    "probuildExpenseId" TEXT,
    "projectName" TEXT,
    "projectValidated" BOOLEAN NOT NULL DEFAULT false,
    "receiptUrl" TEXT,
    "taxValidated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLineObservation" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "sourceLineId" TEXT NOT NULL,
    "postedDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "rawDescriptor" TEXT NOT NULL,
    "checkNumber" TEXT,
    "bankLineId" TEXT,
    "statementImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankLineObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLineItem" (
    "id" TEXT NOT NULL,
    "bankLineId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(65,30),
    "unitPriceCents" INTEGER,
    "lineTotalCents" INTEGER,
    "source" TEXT NOT NULL,
    "jobHint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundEvent" (
    "id" TEXT NOT NULL,
    "originalBankLineId" TEXT,
    "refundBankLineId" TEXT,
    "vendorRefundRef" TEXT,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'EXPECTED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_contentHash_key" ON "StatementImport"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_account_periodStart_periodEnd_key" ON "StatementImport"("account", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "BankLine_account_postedDate_idx" ON "BankLine"("account", "postedDate");

-- CreateIndex
CREATE INDEX "BankLine_qbTxnId_idx" ON "BankLine"("qbTxnId");

-- CreateIndex
CREATE INDEX "BankLineObservation_bankLineId_idx" ON "BankLineObservation"("bankLineId");

-- CreateIndex
CREATE INDEX "BankLineObservation_account_postedDate_idx" ON "BankLineObservation"("account", "postedDate");

-- PostgreSQL's 63-byte physical identifier, mapped explicitly in schema.prisma.
CREATE UNIQUE INDEX "BankLineObservation_source_account_sourceDocumentId_sourceLineI" ON "BankLineObservation"("source", "account", "sourceDocumentId", "sourceLineId");

-- CreateIndex
CREATE INDEX "BankLineItem_bankLineId_idx" ON "BankLineItem"("bankLineId");

-- CreateIndex
CREATE INDEX "RefundEvent_originalBankLineId_idx" ON "RefundEvent"("originalBankLineId");

-- CreateIndex
CREATE INDEX "RefundEvent_refundBankLineId_idx" ON "RefundEvent"("refundBankLineId");

-- AddForeignKey
ALTER TABLE "BankLineObservation" ADD CONSTRAINT "BankLineObservation_bankLineId_fkey" FOREIGN KEY ("bankLineId") REFERENCES "BankLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLineObservation" ADD CONSTRAINT "BankLineObservation_statementImportId_fkey" FOREIGN KEY ("statementImportId") REFERENCES "StatementImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLineItem" ADD CONSTRAINT "BankLineItem_bankLineId_fkey" FOREIGN KEY ("bankLineId") REFERENCES "BankLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_originalBankLineId_fkey" FOREIGN KEY ("originalBankLineId") REFERENCES "BankLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_refundBankLineId_fkey" FOREIGN KEY ("refundBankLineId") REFERENCES "BankLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma-blind DDL (preserved from scripts/apply-bank-ledger.mjs).
DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'StatementImport_status_check' AND conrelid = '"StatementImport"'::regclass
   ) THEN
     ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_status_check"
       CHECK ("status" IN ('PENDING', 'FINALIZED', 'FAILED'));
   END IF;
 END $$;

ALTER TABLE "StatementImport" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'BankLine_state_check' AND conrelid = '"BankLine"'::regclass
   ) THEN
     ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_state_check"
       CHECK ("state" IN ('POSTED', 'EVIDENCE_FOUND', 'TRANSACTION_CREATED', 'ATTACHMENT_CONFIRMED', 'MATCHED', 'JOB_CODED', 'TAX_VALIDATED', 'EXCEPTION'));
   END IF;
 END $$;

ALTER TABLE "BankLine" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'BankLineObservation_source_check' AND conrelid = '"BankLineObservation"'::regclass
   ) THEN
     ALTER TABLE "BankLineObservation" ADD CONSTRAINT "BankLineObservation_source_check"
       CHECK ("source" IN ('STATEMENT', 'QBO_REGISTER'));
   END IF;
 END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "BankLineObservation_source_bankLineId_key"
  ON "BankLineObservation" ("source", "bankLineId")
  WHERE "bankLineId" IS NOT NULL;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'BankLineObservation_source_shape_check' AND conrelid = '"BankLineObservation"'::regclass
   ) THEN
     ALTER TABLE "BankLineObservation" ADD CONSTRAINT "BankLineObservation_source_shape_check"
       CHECK (
         (source = 'STATEMENT' AND "statementImportId" IS NOT NULL AND "bankLineId" IS NOT NULL)
         OR (source = 'QBO_REGISTER' AND "statementImportId" IS NULL)
       );
   END IF;
 END $$;

ALTER TABLE "BankLineObservation" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'BankLineItem_source_check' AND conrelid = '"BankLineItem"'::regclass
   ) THEN
     ALTER TABLE "BankLineItem" ADD CONSTRAINT "BankLineItem_source_check"
       CHECK ("source" IN ('RECEIPT_AI', 'LOWES_CSV', 'AMAZON_APP', 'MANUAL'));
   END IF;
 END $$;

ALTER TABLE "BankLineItem" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'RefundEvent_status_check' AND conrelid = '"RefundEvent"'::regclass
   ) THEN
     ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_status_check"
       CHECK ("status" IN ('EXPECTED', 'CREDIT_SEEN', 'PAIRED', 'POSTED'));
   END IF;
 END $$;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'RefundEvent_amountCents_check' AND conrelid = '"RefundEvent"'::regclass
   ) THEN
     ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_amountCents_check"
       CHECK ("amountCents" > 0);
   END IF;
 END $$;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'RefundEvent_taxCents_check' AND conrelid = '"RefundEvent"'::regclass
   ) THEN
     ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_taxCents_check"
       CHECK ("taxCents" >= 0 AND "taxCents" <= "amountCents");
   END IF;
 END $$;

CREATE OR REPLACE FUNCTION check_refund_event_signs() RETURNS TRIGGER AS $BODY$
     DECLARE
       orig_amount INTEGER;
       refund_amount INTEGER;
     BEGIN
       IF NEW."originalBankLineId" IS NOT NULL THEN
         SELECT "amountCents" INTO orig_amount FROM "BankLine" WHERE "id" = NEW."originalBankLineId";
         IF orig_amount IS NOT NULL AND orig_amount >= 0 THEN
           RAISE EXCEPTION 'RefundEvent.originalBankLineId must reference a debit BankLine (amountCents < 0), got %', orig_amount;
         END IF;
       END IF;
       IF NEW."refundBankLineId" IS NOT NULL THEN
         SELECT "amountCents" INTO refund_amount FROM "BankLine" WHERE "id" = NEW."refundBankLineId";
         IF refund_amount IS NOT NULL AND refund_amount <= 0 THEN
           RAISE EXCEPTION 'RefundEvent.refundBankLineId must reference a credit BankLine (amountCents > 0), got %', refund_amount;
         END IF;
       END IF;
       RETURN NEW;
     END;
     $BODY$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refund_event_signs_trigger ON "RefundEvent";
CREATE TRIGGER refund_event_signs_trigger
  BEFORE INSERT OR UPDATE ON "RefundEvent"
  FOR EACH ROW EXECUTE FUNCTION check_refund_event_signs();

ALTER TABLE "RefundEvent" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION check_bank_line_amount_immutable() RETURNS TRIGGER AS $BODY$
     BEGIN
       IF NEW."amountCents" IS DISTINCT FROM OLD."amountCents" THEN
         RAISE EXCEPTION 'BankLine.amountCents is immutable (id %); amounts come from bank statements and can never be edited — insert a new BankLine/observation instead', OLD."id";
       END IF;
       RETURN NEW;
     END;
     $BODY$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_line_amount_immutable_trigger ON "BankLine";
CREATE TRIGGER bank_line_amount_immutable_trigger
  BEFORE UPDATE ON "BankLine"
  FOR EACH ROW EXECUTE FUNCTION check_bank_line_amount_immutable();
