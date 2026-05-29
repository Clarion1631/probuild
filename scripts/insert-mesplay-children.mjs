/**
 * insert-mesplay-children.mjs
 *
 * Reads EstimateItem data from the MCP-extracted backup JSON and inserts
 * child items (those with parentId) into production via Prisma.
 * Also inserts PaymentSchedules, FileFolder, ProjectFiles, ScheduleTasks, Budget.
 *
 * Usage: node scripts/insert-mesplay-children.mjs [--dry-run]
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const prod = new PrismaClient();

const ESTIMATE_ID = "cmnw712bs00018q3x7bbjc76j";
const PROJECT_ID = "cmnw6ztf60002ircciltw1h7c";
const LEAD_ID = "cmntnqf3w0002rx6f1ne5io7s";
const SIGNED_FOLDER_ID = "cmozz2hwo000113m4jxh5wyx5";

function parseToolResult(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const wrapper = JSON.parse(raw);
  const text = wrapper[0].text;
  const resultObj = JSON.parse(text);
  const resultStr = resultObj.result;
  const match = resultStr.match(/<untrusted-data-[^>]+>\n([\s\S]*?)\n<\/untrusted-data/);
  if (!match) throw new Error("Could not parse MCP result from " + filePath);
  return JSON.parse(match[1]);
}

function dec(v) {
  if (v === null || v === undefined) return v;
  return parseFloat(v.toString());
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  // Parse the MCP tool results directory
  const baseDir = process.argv[2] || "";
  if (!baseDir) {
    console.error("Usage: node scripts/insert-mesplay-children.mjs <tool-results-dir> [--dry-run]");
    process.exit(1);
  }

  // Read item data from the persisted MCP output
  const itemsFile = process.argv[3];
  if (!itemsFile) {
    console.error("Usage: node scripts/insert-mesplay-children.mjs <items-json> <payments-json> <files-json> <tasks-json> <budget-json> <folder-json> [--dry-run]");
    process.exit(1);
  }

  console.log("Reading data files...");
  const allItems = JSON.parse(readFileSync(process.argv[2], "utf-8"));
  const payments = JSON.parse(readFileSync(process.argv[3], "utf-8"));
  const files = JSON.parse(readFileSync(process.argv[4], "utf-8"));
  const tasks = JSON.parse(readFileSync(process.argv[5], "utf-8"));
  const budgets = JSON.parse(readFileSync(process.argv[6], "utf-8"));
  const folders = JSON.parse(readFileSync(process.argv[7], "utf-8"));

  const childItems = allItems.filter(i => i.parentId !== null);
  console.log(`  ${childItems.length} child EstimateItems`);
  console.log(`  ${payments.length} PaymentSchedules`);
  console.log(`  ${files.length} ProjectFiles`);
  console.log(`  ${tasks.length} ScheduleTasks`);
  console.log(`  ${budgets.length} Budgets`);
  console.log(`  ${folders.length} FileFolders`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would insert the above. Exiting.");
    return;
  }

  // Insert child EstimateItems
  console.log("\nInserting child EstimateItems...");
  for (const item of childItems) {
    await prod.estimateItem.create({
      data: {
        id: item.id,
        estimateId: ESTIMATE_ID,
        name: item.name,
        description: item.description || "",
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
        createdAt: new Date(item.createdAt),
      },
    });
    console.log(`  + ${item.id} (order ${item.order}): ${item.name.substring(0, 50)}`);
  }

  // Insert PaymentSchedules
  console.log("\nInserting PaymentSchedules...");
  for (const ps of payments) {
    await prod.estimatePaymentSchedule.create({
      data: {
        id: ps.id,
        estimateId: ESTIMATE_ID,
        name: ps.name,
        percentage: ps.percentage,
        amount: dec(ps.amount),
        dueDate: ps.dueDate ? new Date(ps.dueDate) : null,
        order: ps.order,
        createdAt: new Date(ps.createdAt),
        status: ps.status,
        stripeSessionId: ps.stripeSessionId,
        stripePaymentIntentId: ps.stripePaymentIntentId,
        paymentMethod: ps.paymentMethod,
        referenceNumber: ps.referenceNumber,
        notes: ps.notes,
        receiptSentAt: ps.receiptSentAt ? new Date(ps.receiptSentAt) : null,
        paidAt: ps.paidAt ? new Date(ps.paidAt) : null,
        paymentDate: ps.paymentDate ? new Date(ps.paymentDate) : null,
      },
    });
    console.log(`  + ${ps.id}: ${ps.name}`);
  }

  // Insert FileFolder
  console.log("\nInserting FileFolders...");
  for (const f of folders) {
    const existing = await prod.fileFolder.findUnique({ where: { id: f.id } });
    if (!existing) {
      await prod.fileFolder.create({
        data: {
          id: f.id,
          name: f.name,
          projectId: f.projectId,
          leadId: f.leadId,
          parentId: f.parentId,
          visibility: f.visibility,
          createdAt: new Date(f.createdAt),
          updatedAt: new Date(f.updatedAt),
        },
      });
      console.log(`  + ${f.id}: ${f.name}`);
    } else {
      console.log(`  = ${f.id}: already exists`);
    }
  }

  // Insert ProjectFiles
  console.log("\nInserting ProjectFiles...");
  for (const f of files) {
    await prod.projectFile.create({
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
        createdAt: new Date(f.createdAt),
      },
    });
    console.log(`  + ${f.id}: ${f.name.substring(0, 50)}`);
  }

  // Insert ScheduleTasks (all top-level, no children in this dataset)
  console.log("\nInserting ScheduleTasks...");
  const topTasks = tasks.filter(t => !t.parentId);
  const childTasks = tasks.filter(t => t.parentId);
  for (const t of topTasks) {
    await prod.scheduleTask.create({
      data: {
        id: t.id,
        projectId: t.projectId,
        leadId: t.leadId,
        name: t.name,
        startDate: t.startDate ? new Date(t.startDate) : null,
        endDate: t.endDate ? new Date(t.endDate) : null,
        color: t.color,
        progress: t.progress,
        estimatedHours: t.estimatedHours,
        assignee: t.assignee,
        parentId: null,
        order: t.order,
        status: t.status,
        type: t.type,
        estimateItemId: t.estimateItemId,
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(t.updatedAt),
      },
    });
    console.log(`  + ${t.id}: ${t.name}`);
  }
  for (const t of childTasks) {
    await prod.scheduleTask.create({
      data: {
        id: t.id,
        projectId: t.projectId,
        leadId: t.leadId,
        name: t.name,
        startDate: t.startDate ? new Date(t.startDate) : null,
        endDate: t.endDate ? new Date(t.endDate) : null,
        color: t.color,
        progress: t.progress,
        estimatedHours: t.estimatedHours,
        assignee: t.assignee,
        parentId: t.parentId,
        order: t.order,
        status: t.status,
        type: t.type,
        estimateItemId: t.estimateItemId,
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(t.updatedAt),
      },
    });
    console.log(`  + ${t.id}: ${t.name} (child)`);
  }

  // Insert Budget
  console.log("\nInserting Budgets...");
  for (const b of budgets) {
    await prod.budget.create({
      data: {
        id: b.id,
        projectId: b.projectId,
        estimateId: b.estimateId,
        totalLaborBudget: dec(b.totalLaborBudget),
        totalMaterialBudget: dec(b.totalMaterialBudget),
        createdAt: new Date(b.createdAt),
        updatedAt: new Date(b.updatedAt),
      },
    });
    console.log(`  + ${b.id}`);
  }

  // Verification
  console.log("\n=== Verification ===");
  const itemCount = await prod.estimateItem.count({ where: { estimateId: ESTIMATE_ID } });
  console.log(`EstimateItems: ${itemCount}`);
  const paymentCount = await prod.estimatePaymentSchedule.count({ where: { estimateId: ESTIMATE_ID } });
  console.log(`PaymentSchedules: ${paymentCount}`);
  const fileCount = await prod.projectFile.count({ where: { OR: [{ projectId: PROJECT_ID }, { leadId: LEAD_ID }] } });
  console.log(`ProjectFiles: ${fileCount}`);
  const taskCount = await prod.scheduleTask.count({ where: { OR: [{ projectId: PROJECT_ID }, { leadId: LEAD_ID }] } });
  console.log(`ScheduleTasks: ${taskCount}`);
  const budgetCount = await prod.budget.count({ where: { projectId: PROJECT_ID } });
  console.log(`Budgets: ${budgetCount}`);

  console.log("\n=== Done ===");
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exit(1); })
  .finally(() => prod.$disconnect());
