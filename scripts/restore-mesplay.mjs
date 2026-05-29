/**
 * restore-mesplay.mjs
 *
 * Restores the Mesplay Whole House Remodel project from the backup Supabase
 * database into the production database.
 *
 * Usage:
 *   BACKUP_DATABASE_URL="postgresql://..." node scripts/restore-mesplay.mjs
 *
 * Or set the BACKUP_DATABASE_URL environment variable before running.
 *
 * What it restores:
 *   - Client (Caleb Mesplay and Robyne Balog-Ressler)
 *   - Lead #177 (Mesplay)
 *   - Project #163 (Mesplay)
 *   - Estimate #242 (Revised Remodel Estimate) + signatureUrl from backup
 *   - EstimateItems (all, from backup)
 *   - EstimatePaymentSchedules (all, from backup)
 *   - ProjectFiles (all, from backup)
 *   - ScheduleTasks (all, from backup)
 *   - Budget (from backup)
 *
 * The entire operation runs in a Prisma interactive transaction so it's
 * all-or-nothing.
 */

import { PrismaClient } from "@prisma/client";

// ── Config ────────────────────────────────────────────────────────────
const BACKUP_URL = process.env.BACKUP_DATABASE_URL;
if (!BACKUP_URL) {
  console.error("ERROR: BACKUP_DATABASE_URL environment variable is required.");
  console.error("Usage: BACKUP_DATABASE_URL=\"postgresql://...\" node scripts/restore-mesplay.mjs");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");

// ── Known IDs ─────────────────────────────────────────────────────────
const CLIENT_ID   = "cmntnqen40000rx6fgcwjgo1z";
const LEAD_ID     = "cmntnqf3w0002rx6f1ne5io7s";
const PROJECT_ID  = "cmnw6ztf60002ircciltw1h7c";
const ESTIMATE_ID = "cmnw712bs00018q3x7bbjc76j";
const MANAGER_ID  = "cmn6oqt0p0000ovrrfodtwmvl";

// ── Prisma clients ────────────────────────────────────────────────────
const prod = new PrismaClient();
const backup = new PrismaClient({
  datasources: { db: { url: BACKUP_URL } },
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Convert Prisma Decimal fields to plain numbers for re-insertion */
function dec(v) {
  if (v === null || v === undefined) return v;
  return parseFloat(v.toString());
}

/** Strip Prisma-managed relation fields and metadata before create */
function stripRelations(row, extraOmit = []) {
  const omit = new Set([
    // Common Prisma virtual / relation fields
    "estimate", "project", "lead", "client", "parent", "subItems",
    "children", "costCode", "costType", "estimateItem", "scheduleTask",
    "folder", "uploadedBy", "manager", "budget", "takeoff", "items",
    "expenses", "paymentSchedules", "files", "contract",
    "dependencies", "dependents", "timeEntries", "comments",
    "punchItems", "assignments", "subAssignments",
    "changeOrders", "estimateFiles",
    ...extraOmit,
  ]);
  const clean = {};
  for (const [k, v] of Object.entries(row)) {
    if (!omit.has(k)) clean[k] = v;
  }
  return clean;
}

/** Log a table of IDs for verification */
function logIds(label, rows) {
  console.log(`  ${label}: ${rows.length} records`);
  if (rows.length <= 6) {
    rows.forEach(r => console.log(`    - ${r.id}`));
  } else {
    rows.slice(0, 3).forEach(r => console.log(`    - ${r.id}`));
    console.log(`    ... (${rows.length - 3} more)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Mesplay Restoration Script ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log("");

  // ── Step 0: Pre-flight checks ─────────────────────────────────────
  console.log("[0] Pre-flight checks...");

  const existingClient = await prod.client.findUnique({ where: { id: CLIENT_ID } });
  if (existingClient) {
    console.error(`  ABORT: Client ${CLIENT_ID} already exists in production.`);
    process.exit(1);
  }

  const existingLead = await prod.lead.findUnique({ where: { id: LEAD_ID } });
  if (existingLead) {
    console.error(`  ABORT: Lead ${LEAD_ID} already exists in production.`);
    process.exit(1);
  }

  const existingProject = await prod.project.findUnique({ where: { id: PROJECT_ID } });
  if (existingProject) {
    console.error(`  ABORT: Project ${PROJECT_ID} already exists in production.`);
    process.exit(1);
  }

  const existingEstimate = await prod.estimate.findUnique({ where: { id: ESTIMATE_ID } });
  if (existingEstimate) {
    console.error(`  ABORT: Estimate ${ESTIMATE_ID} already exists in production.`);
    process.exit(1);
  }

  // Verify the manager exists in production
  const manager = await prod.user.findUnique({ where: { id: MANAGER_ID } });
  if (!manager) {
    console.error(`  ABORT: Manager ${MANAGER_ID} not found in production.`);
    process.exit(1);
  }
  console.log(`  Manager verified: ${manager.name} (${manager.email})`);

  // ── Step 1: Read all data from backup ─────────────────────────────
  console.log("\n[1] Reading data from backup database...");

  const backupEstimate = await backup.estimate.findUnique({
    where: { id: ESTIMATE_ID },
  });
  if (!backupEstimate) {
    console.error(`  ABORT: Estimate ${ESTIMATE_ID} not found in backup.`);
    process.exit(1);
  }
  console.log(`  Estimate found: "${backupEstimate.title}" (${backupEstimate.code})`);
  console.log(`  signatureUrl length: ${backupEstimate.signatureUrl?.length ?? 0} chars`);

  const backupItems = await backup.estimateItem.findMany({
    where: { estimateId: ESTIMATE_ID },
    orderBy: { order: "asc" },
  });
  logIds("EstimateItems", backupItems);

  const backupPayments = await backup.estimatePaymentSchedule.findMany({
    where: { estimateId: ESTIMATE_ID },
    orderBy: { order: "asc" },
  });
  logIds("PaymentSchedules", backupPayments);

  const backupFiles = await backup.projectFile.findMany({
    where: { projectId: PROJECT_ID },
  });
  logIds("ProjectFiles", backupFiles);

  // Also get lead files (some may be on the lead, not the project)
  const backupLeadFiles = await backup.projectFile.findMany({
    where: { leadId: LEAD_ID, projectId: null },
  });
  if (backupLeadFiles.length > 0) {
    logIds("LeadFiles", backupLeadFiles);
  }

  const backupTasks = await backup.scheduleTask.findMany({
    where: {
      OR: [
        { projectId: PROJECT_ID },
        { leadId: LEAD_ID },
      ],
    },
    orderBy: { order: "asc" },
  });
  logIds("ScheduleTasks", backupTasks);

  const backupBudgets = await backup.budget.findMany({
    where: { projectId: PROJECT_ID },
  });
  logIds("Budgets", backupBudgets);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would insert the above records. Exiting without changes.");
    return;
  }

  // ── Step 2: Insert everything in a transaction ────────────────────
  console.log("\n[2] Inserting into production (transactional)...");

  await prod.$transaction(async (tx) => {

    // 2a. Client
    console.log("  [2a] Creating Client...");
    await tx.client.create({
      data: {
        id: CLIENT_ID,
        name: "Caleb Mesplay and Robyne Balog-Ressler",
        initials: "CA",
        email: "caleb.mesplay@gmail.com",
        primaryPhone: "3607878263",
        addressLine1: "709 West 32nd Street",
        city: "Vancouver",
        state: "WA",
        zipCode: "98660",
        primaryPhoneE164: "+13607878263",
      },
    });
    console.log(`    Client created: ${CLIENT_ID}`);

    // 2b. Lead (number: 177)
    console.log("  [2b] Creating Lead #177...");
    await tx.$executeRawUnsafe(`
      INSERT INTO "Lead" (
        "id", "number", "name", "clientId", "stage", "source",
        "projectType", "location", "createdAt", "isArchived",
        "isUnread", "lastActivityAt", "managerId"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9::timestamptz, $10,
        $11, $12::timestamptz, $13
      )`,
      LEAD_ID,
      177,
      "Mesplay",
      CLIENT_ID,
      "Won",
      "Manually Created",
      "Whole House Remodel",
      "709 w 32 st Vancouver Washington 98660",
      new Date("2026-04-11T01:29:46.748Z"),
      false,
      true,
      new Date("2026-04-11T01:29:46.748Z"),
      MANAGER_ID,
    );
    console.log(`    Lead created: ${LEAD_ID} (number: 177)`);

    // 2c. Project (number: 163)
    console.log("  [2c] Creating Project #163...");
    await tx.$executeRawUnsafe(`
      INSERT INTO "Project" (
        "id", "number", "name", "clientId", "viewedAt", "createdAt",
        "location", "status", "type", "leadId", "color",
        "geofenceRadiusMeters"
      ) VALUES (
        $1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
        $7, $8, $9, $10, $11,
        $12
      )`,
      PROJECT_ID,
      163,
      "Mesplay",
      CLIENT_ID,
      new Date("2026-04-12T20:04:30.258Z"),
      new Date("2026-04-12T20:04:30.258Z"),
      "709 w 32 st Vancouver Washington 98660",
      "Paid, Ready to Start",
      "Whole House Remodel",
      LEAD_ID,
      "#3b82f6",
      100,
    );
    console.log(`    Project created: ${PROJECT_ID} (number: 163)`);

    // 2d. Estimate (number: 242) - read signatureUrl from backup
    console.log("  [2d] Creating Estimate #242...");
    await tx.$executeRawUnsafe(`
      INSERT INTO "Estimate" (
        "id", "number", "title", "projectId", "code", "status",
        "privacy", "createdAt", "totalAmount", "balanceDue",
        "approvedBy", "approvedAt", "signatureUrl",
        "viewedAt", "sentAt",
        "processingFeeMarkup", "hideProcessingFee", "expirationDate",
        "targetMarginPercent", "taxExempt", "taxRateName", "taxRatePercent"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8::timestamptz, $9, $10,
        $11, $12::timestamptz, $13,
        $14::timestamptz, $15::timestamptz,
        $16, $17, $18::timestamptz,
        $19, $20, $21, $22
      )`,
      ESTIMATE_ID,
      242,
      "Revised Remodel Estimate",
      PROJECT_ID,
      "EST-4226-3",
      "Approved",
      "Shared",
      new Date("2026-04-12T20:05:28.456Z"),
      239224,
      239224,
      "Robyne E Balog-Ressler",
      new Date("2026-05-10T16:13:20.582Z"),
      backupEstimate.signatureUrl,   // read from backup at runtime
      new Date("2026-04-12T22:49:21.856Z"),
      new Date("2026-05-08T01:08:20.946Z"),
      0,
      true,
      new Date("2026-05-11T00:00:00.000Z"),
      25,
      false,
      "Vancouver",
      8.8,
    );
    console.log(`    Estimate created: ${ESTIMATE_ID} (number: 242)`);

    // 2e. EstimateItems (bulk from backup)
    console.log(`  [2e] Creating ${backupItems.length} EstimateItems...`);
    // Insert items respecting parent-child hierarchy:
    // first pass = items without parentId, second pass = items with parentId.
    const topLevel = backupItems.filter(i => !i.parentId);
    const children = backupItems.filter(i => i.parentId);

    for (const item of topLevel) {
      await tx.estimateItem.create({
        data: {
          id: item.id,
          estimateId: ESTIMATE_ID,
          name: item.name,
          description: item.description,
          type: item.type,
          quantity: item.quantity,
          baseCost: dec(item.baseCost),
          markupPercent: item.markupPercent,
          unitCost: dec(item.unitCost),
          total: dec(item.total),
          order: item.order,
          parentId: null,
          costCodeId: item.costCodeId,
          costTypeId: item.costTypeId,
          approvalStatus: item.approvalStatus,
          approvalNote: item.approvalNote,
          purchaseOrderId: item.purchaseOrderId,
          budgetQuantity: item.budgetQuantity,
          budgetUnit: item.budgetUnit,
          budgetRate: dec(item.budgetRate),
          createdAt: item.createdAt,
        },
      });
    }
    console.log(`    Inserted ${topLevel.length} top-level items`);

    for (const item of children) {
      await tx.estimateItem.create({
        data: {
          id: item.id,
          estimateId: ESTIMATE_ID,
          name: item.name,
          description: item.description,
          type: item.type,
          quantity: item.quantity,
          baseCost: dec(item.baseCost),
          markupPercent: item.markupPercent,
          unitCost: dec(item.unitCost),
          total: dec(item.total),
          order: item.order,
          parentId: item.parentId,
          costCodeId: item.costCodeId,
          costTypeId: item.costTypeId,
          approvalStatus: item.approvalStatus,
          approvalNote: item.approvalNote,
          purchaseOrderId: item.purchaseOrderId,
          budgetQuantity: item.budgetQuantity,
          budgetUnit: item.budgetUnit,
          budgetRate: dec(item.budgetRate),
          createdAt: item.createdAt,
        },
      });
    }
    console.log(`    Inserted ${children.length} child items`);

    // 2f. EstimatePaymentSchedules (from backup)
    console.log(`  [2f] Creating ${backupPayments.length} PaymentSchedules...`);
    for (const ps of backupPayments) {
      await tx.estimatePaymentSchedule.create({
        data: {
          id: ps.id,
          estimateId: ESTIMATE_ID,
          name: ps.name,
          percentage: ps.percentage,
          amount: dec(ps.amount),
          dueDate: ps.dueDate,
          order: ps.order,
          createdAt: ps.createdAt,
          status: ps.status,
          stripeSessionId: ps.stripeSessionId,
          stripePaymentIntentId: ps.stripePaymentIntentId,
          paymentMethod: ps.paymentMethod,
          referenceNumber: ps.referenceNumber,
          notes: ps.notes,
          receiptSentAt: ps.receiptSentAt,
          paidAt: ps.paidAt,
          paymentDate: ps.paymentDate,
        },
      });
    }
    console.log(`    Inserted ${backupPayments.length} payment schedules`);

    // 2g. FileFolder (the "Signed Documents" folder referenced by the signed estimate PDF)
    const SIGNED_FOLDER_ID = "cmozz2hwo000113m4jxh5wyx5";
    const existingFolder = await tx.fileFolder.findUnique({ where: { id: SIGNED_FOLDER_ID } });
    if (!existingFolder) {
      console.log("  [2g] Creating FileFolder 'Signed Documents'...");
      await tx.fileFolder.create({
        data: {
          id: SIGNED_FOLDER_ID,
          name: "Signed Documents",
          projectId: PROJECT_ID,
          visibility: "team",
          createdAt: new Date("2026-05-10T16:13:25.416Z"),
          updatedAt: new Date("2026-05-10T16:13:25.416Z"),
        },
      });
      console.log(`    FileFolder created: ${SIGNED_FOLDER_ID}`);
    }

    // 2h. ProjectFiles (from backup)
    const allFiles = [...backupFiles, ...backupLeadFiles];
    console.log(`  [2h] Creating ${allFiles.length} ProjectFiles...`);
    for (const f of allFiles) {
      await tx.projectFile.create({
        data: {
          id: f.id,
          name: f.name,
          url: f.url,
          size: f.size,
          mimeType: f.mimeType,
          visibility: f.visibility,
          projectId: f.projectId,
          leadId: f.leadId,
          folderId: f.folderId,
          uploadedById: f.uploadedById,
          createdAt: f.createdAt,
        },
      });
    }
    console.log(`    Inserted ${allFiles.length} files`);

    // 2i. ScheduleTasks (from backup)
    // Same parent-child approach as estimate items
    console.log(`  [2i] Creating ${backupTasks.length} ScheduleTasks...`);
    const topTasks = backupTasks.filter(t => !t.parentId);
    const childTasks = backupTasks.filter(t => t.parentId);

    for (const t of topTasks) {
      await tx.scheduleTask.create({
        data: {
          id: t.id,
          projectId: t.projectId,
          leadId: t.leadId,
          name: t.name,
          startDate: t.startDate,
          endDate: t.endDate,
          color: t.color,
          progress: t.progress,
          estimatedHours: t.estimatedHours,
          assignee: t.assignee,
          parentId: null,
          order: t.order,
          status: t.status,
          type: t.type,
          estimateItemId: t.estimateItemId,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        },
      });
    }

    for (const t of childTasks) {
      await tx.scheduleTask.create({
        data: {
          id: t.id,
          projectId: t.projectId,
          leadId: t.leadId,
          name: t.name,
          startDate: t.startDate,
          endDate: t.endDate,
          color: t.color,
          progress: t.progress,
          estimatedHours: t.estimatedHours,
          assignee: t.assignee,
          parentId: t.parentId,
          order: t.order,
          status: t.status,
          type: t.type,
          estimateItemId: t.estimateItemId,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        },
      });
    }
    console.log(`    Inserted ${topTasks.length} top-level + ${childTasks.length} child tasks`);

    // 2j. Budget (from backup)
    console.log(`  [2j] Creating ${backupBudgets.length} Budget(s)...`);
    for (const b of backupBudgets) {
      await tx.budget.create({
        data: {
          id: b.id,
          projectId: b.projectId,
          estimateId: b.estimateId,
          totalLaborBudget: dec(b.totalLaborBudget),
          totalMaterialBudget: dec(b.totalMaterialBudget),
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        },
      });
    }
    console.log(`    Inserted ${backupBudgets.length} budget(s)`);
  }, {
    // Transaction config: give it plenty of time for the bulk inserts
    maxWait: 30000,   // 30s to acquire a connection
    timeout: 120000,  // 2 min for the transaction itself
  });

  // ── Step 3: Verification ──────────────────────────────────────────
  console.log("\n[3] Verifying insertion...");

  const verifyClient = await prod.client.findUnique({ where: { id: CLIENT_ID } });
  console.log(`  Client: ${verifyClient ? "OK" : "MISSING"} - ${verifyClient?.name}`);

  const verifyLead = await prod.lead.findUnique({ where: { id: LEAD_ID } });
  console.log(`  Lead:   ${verifyLead ? "OK" : "MISSING"} - #${verifyLead?.number} ${verifyLead?.name}`);

  const verifyProject = await prod.project.findUnique({ where: { id: PROJECT_ID } });
  console.log(`  Project: ${verifyProject ? "OK" : "MISSING"} - #${verifyProject?.number} ${verifyProject?.name}`);

  const verifyEstimate = await prod.estimate.findUnique({ where: { id: ESTIMATE_ID } });
  console.log(`  Estimate: ${verifyEstimate ? "OK" : "MISSING"} - #${verifyEstimate?.number} ${verifyEstimate?.title}`);
  console.log(`    totalAmount: $${verifyEstimate?.totalAmount}`);
  console.log(`    status: ${verifyEstimate?.status}`);
  console.log(`    signatureUrl: ${verifyEstimate?.signatureUrl ? `${verifyEstimate.signatureUrl.length} chars` : "null"}`);

  const verifyItems = await prod.estimateItem.count({ where: { estimateId: ESTIMATE_ID } });
  console.log(`  EstimateItems: ${verifyItems}`);

  const verifyPayments = await prod.estimatePaymentSchedule.count({ where: { estimateId: ESTIMATE_ID } });
  console.log(`  PaymentSchedules: ${verifyPayments}`);

  const verifyFiles = await prod.projectFile.count({
    where: { OR: [{ projectId: PROJECT_ID }, { leadId: LEAD_ID }] },
  });
  console.log(`  ProjectFiles: ${verifyFiles}`);

  const verifyTasks = await prod.scheduleTask.count({
    where: { OR: [{ projectId: PROJECT_ID }, { leadId: LEAD_ID }] },
  });
  console.log(`  ScheduleTasks: ${verifyTasks}`);

  const verifyBudgets = await prod.budget.count({ where: { projectId: PROJECT_ID } });
  console.log(`  Budgets: ${verifyBudgets}`);

  console.log("\n=== Restoration complete! ===");
}

main()
  .catch((e) => {
    console.error("\nFATAL ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prod.$disconnect();
    await backup.$disconnect();
  });
