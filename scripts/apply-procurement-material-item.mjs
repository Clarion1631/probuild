#!/usr/bin/env node
/**
 * Additive Procurement V1 schema. This script never drops, truncates, or alters
 * an existing table. It requires an independently-created backup manifest to
 * make the database/host decision explicit before the one production run.
 */
import fs from "node:fs";
import pg from "pg";

export const PROCUREMENT_TABLES = [
  "MaterialImportRun",
  "MaterialImportRow",
  "MaterialItem",
  "MaterialItemEvidence",
  "MaterialItemEvent",
  "MaterialItemPurchaseOrderItem",
  "MaterialItemExpense",
  "MaterialItemSource",
  "ProcurementAuthorityConfig",
];

export function targetMatches(actual, expectedDb, expectedHost) {
  return actual.db === expectedDb && actual.host === expectedHost;
}

function requiredFlag(args, flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? null : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${flag}`);
  return value;
}

function parseTarget(connectionString) {
  const url = new URL(connectionString);
  return { db: decodeURIComponent(url.pathname.replace(/^\//, "")), host: url.hostname };
}

function assertBackupManifest(manifestPath, expected) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (parsed.database !== expected.db || parsed.host !== expected.host) {
    throw new Error("Backup manifest target does not match the requested database/host");
  }
  if (!parsed.createdAt || Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new Error("Backup manifest is missing a valid createdAt timestamp");
  }
  if (Date.now() - Date.parse(parsed.createdAt) > 24 * 60 * 60 * 1000) {
    throw new Error("Backup manifest is older than 24 hours; take and verify a new backup");
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS "MaterialImportRun" (
  "id" TEXT PRIMARY KEY,
  "ingestPath" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "sourceFileName" TEXT,
  "storagePath" TEXT,
  "sourceRevision" TEXT,
  "sourceHash" TEXT NOT NULL,
  "commitScopeHash" TEXT NOT NULL,
  "requestedProjectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
  "createdById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'STAGED' CHECK ("status" IN ('STAGED','APPLIED','FAILED')),
  "rowCount" INTEGER NOT NULL DEFAULT 0 CHECK ("rowCount" >= 0),
  "dataGapCount" INTEGER NOT NULL DEFAULT 0 CHECK ("dataGapCount" >= 0),
  "conflictCount" INTEGER NOT NULL DEFAULT 0 CHECK ("conflictCount" >= 0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "appliedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "MaterialImportRow" (
  "id" TEXT PRIMARY KEY,
  "importRunId" TEXT NOT NULL REFERENCES "MaterialImportRun"("id") ON DELETE CASCADE,
  "rowNumber" INTEGER NOT NULL CHECK ("rowNumber" > 0),
  "rawJson" JSONB NOT NULL,
  "normalizedJson" JSONB,
  "validationState" TEXT NOT NULL CHECK ("validationState" IN ('READY','DATA_GAP','PROJECT_CONFLICT','INVALID')),
  "materialItemId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("importRunId", "rowNumber")
);

CREATE TABLE IF NOT EXISTS "MaterialItem" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
  "estimateItemId" TEXT REFERENCES "EstimateItem"("id") ON DELETE SET NULL,
  "scheduleTaskId" TEXT REFERENCES "ScheduleTask"("id") ON DELETE SET NULL,
  "description" TEXT NOT NULL,
  "vendorName" TEXT,
  "manufacturer" TEXT,
  "model" TEXT,
  "sku" TEXT,
  "quantity" NUMERIC(14,3) NOT NULL DEFAULT 1 CHECK ("quantity" > 0),
  "unit" TEXT,
  "unitCost" NUMERIC(14,2),
  "totalCost" NUMERIC(14,2),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "needByDate" DATE,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED' CHECK ("status" IN ('REQUESTED','QUOTED','APPROVED','ORDERED','SHIPPED','RECEIVED','DELAYED')),
  "receivedAt" DATE,
  "isManual" BOOLEAN NOT NULL DEFAULT false,
  "sourceProjectRef" TEXT,
  "createdById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "updatedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ("totalCost" IS NULL OR "totalCost" >= 0),
  CHECK ("unitCost" IS NULL OR "unitCost" >= 0)
);

CREATE TABLE IF NOT EXISTS "MaterialItemEvidence" (
  "id" TEXT PRIMARY KEY,
  "materialItemId" TEXT NOT NULL REFERENCES "MaterialItem"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('SOURCE_IMPORT','VENDOR_QUOTE','APPROVAL_DECISION','PURCHASE_ORDER','SHIPMENT_NOTICE','DELIVERY_RECEIPT','RICHARD_CONFIRMATION')),
  "provenance" TEXT NOT NULL CHECK ("provenance" IN ('VENDOR','CARRIER','ADMIN','MANUAL','SYSTEM')),
  "ingestPath" TEXT NOT NULL,
  "sourceIdentity" TEXT NOT NULL,
  "sourceRevision" TEXT,
  "sourceHash" TEXT NOT NULL,
  "commitScopeHash" TEXT NOT NULL,
  "url" TEXT,
  "payload" JSONB,
  "isCurrent" BOOLEAN NOT NULL DEFAULT true,
  "approvedQuoteEvidenceId" TEXT REFERENCES "MaterialItemEvidence"("id") ON DELETE RESTRICT,
  "createdById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("ingestPath", "sourceIdentity")
);

CREATE TABLE IF NOT EXISTS "MaterialItemEvent" (
  "id" TEXT PRIMARY KEY,
  "materialItemId" TEXT NOT NULL REFERENCES "MaterialItem"("id") ON DELETE CASCADE,
  "eventType" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "reason" TEXT,
  "evidenceId" TEXT REFERENCES "MaterialItemEvidence"("id") ON DELETE RESTRICT,
  "actorId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "actorRole" TEXT,
  "ingestPath" TEXT NOT NULL,
  "correlationKey" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "commitScopeHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("ingestPath", "correlationKey", "eventType")
);

CREATE TABLE IF NOT EXISTS "MaterialItemPurchaseOrderItem" (
  "materialItemId" TEXT NOT NULL REFERENCES "MaterialItem"("id") ON DELETE CASCADE,
  "purchaseOrderItemId" TEXT NOT NULL REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY("materialItemId", "purchaseOrderItemId")
);

CREATE TABLE IF NOT EXISTS "MaterialItemExpense" (
  "materialItemId" TEXT NOT NULL REFERENCES "MaterialItem"("id") ON DELETE CASCADE,
  "expenseId" TEXT NOT NULL REFERENCES "Expense"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY("materialItemId", "expenseId")
);

CREATE TABLE IF NOT EXISTS "MaterialItemSource" (
  "id" TEXT PRIMARY KEY,
  "materialItemId" TEXT NOT NULL REFERENCES "MaterialItem"("id") ON DELETE CASCADE,
  "sourceKind" TEXT NOT NULL CHECK ("sourceKind" IN ('XLSX','GMAIL','DRIVE','MANUAL_RICHARD','PURCHASE_ORDER','QBO_EXPENSE')),
  "sourceIdentity" TEXT NOT NULL,
  "sourceRevision" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("sourceKind", "sourceIdentity"),
  UNIQUE("materialItemId", "sourceKind", "sourceIdentity")
);

CREATE TABLE IF NOT EXISTS "ProcurementAuthorityConfig" (
  "id" TEXT PRIMARY KEY,
  "richardUserId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE RESTRICT,
  "updatedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialImportRun_ingestPath_requestKey_key" ON "MaterialImportRun"("ingestPath", "requestKey");
CREATE INDEX IF NOT EXISTS "MaterialImportRun_requestedProjectId_createdAt_idx" ON "MaterialImportRun"("requestedProjectId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "MaterialImportRow_importRunId_validationState_idx" ON "MaterialImportRow"("importRunId", "validationState");
CREATE INDEX IF NOT EXISTS "MaterialItem_projectId_status_idx" ON "MaterialItem"("projectId", "status");
CREATE INDEX IF NOT EXISTS "MaterialItem_needByDate_idx" ON "MaterialItem"("needByDate");
CREATE INDEX IF NOT EXISTS "MaterialItemEvidence_materialItemId_kind_current_idx" ON "MaterialItemEvidence"("materialItemId", "kind", "isCurrent");
CREATE INDEX IF NOT EXISTS "MaterialItemEvent_materialItemId_createdAt_idx" ON "MaterialItemEvent"("materialItemId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "MaterialItemSource_materialItemId_idx" ON "MaterialItemSource"("materialItemId");
`;

export async function applyProcurementSchema({ connectionString, expectedDb, expectedHost, backupManifest }) {
  const configured = parseTarget(connectionString);
  if (!targetMatches(configured, expectedDb, expectedHost)) {
    throw new Error("DATABASE_URL target does not match --expect-db/--expect-host");
  }
  assertBackupManifest(backupManifest, configured);

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const actual = await client.query("SELECT current_database() AS db, COALESCE(inet_server_addr()::text, '') AS host");
    if (!targetMatches(actual.rows[0], expectedDb, expectedHost)) {
      throw new Error("Connected database target does not match --expect-db/--expect-host");
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('probuild-procurement-v1-schema'))");
    await client.query(DDL);
    const result = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename", [PROCUREMENT_TABLES]);
    if (result.rows.length !== PROCUREMENT_TABLES.length) throw new Error("Procurement schema verification failed");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const expectedDb = requiredFlag(args, "--expect-db");
  const expectedHost = requiredFlag(args, "--expect-host");
  const backupManifest = requiredFlag(args, "--backup-manifest");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await applyProcurementSchema({ connectionString: process.env.DATABASE_URL, expectedDb, expectedHost, backupManifest });
  console.log("Procurement V1 additive schema applied and verified.");
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1].replace(/\\/g, "/")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Procurement schema apply failed");
    process.exitCode = 1;
  });
}
