import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function exportSource(source: string, name: string): string {
  const marker = new RegExp(`export\\s+(?:async function|const)\\s+${name}\\b`);
  const match = marker.exec(source);
  expect(match, `${name} must remain exported`).not.toBeNull();
  const start = match!.index;
  const remainder = source.slice(start + match![0].length);
  const next = /\nexport\s+(?:async function|const)\s+/.exec(remainder);
  return source.slice(start, next ? start + match![0].length + next.index : undefined);
}

function expectGuardBeforeDatabase(source: string, actionName: string, guard: string) {
  const action = exportSource(source, actionName);
  const guardIndex = action.indexOf(guard);
  const databaseIndex = action.indexOf("prisma.");
  expect(guardIndex, `${actionName} must call ${guard}`).toBeGreaterThanOrEqual(0);
  if (databaseIndex >= 0) {
    expect(guardIndex, `${actionName} must authorize before database access`).toBeLessThan(databaseIndex);
  }
}

test("all staff financial actions authorize inside the exported action", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");

  const estimates = [
    "getEstimate", "getAllEstimates", "getEstimateActivity", "createDraftEstimate",
    "createDraftLeadEstimate", "saveEstimate", "logEstimatePayment", "archiveEstimate",
    "deleteEstimate", "duplicateEstimate", "saveEstimateAsTemplate", "getEstimateTemplates",
    "createEstimateFromTemplate", "saveItemsAsAssembly", "deleteAssembly",
    "getEstimateItemsForProject", "importEstimateToSchedule", "uploadEstimateFile",
    "deleteEstimateFile", "getEstimateFiles", "updateItemApproval", "bulkUpdateItemApproval",
    "addVoiceEstimateItem", "createEstimateFromRoomDesign",
  ];
  for (const name of estimates) expectGuardBeforeDatabase(source, name, "await assertEstimatePermission(");

  const invoices = [
    "deleteInvoice", "updateInvoiceNotes", "createInvoiceFromTimeEntries", "getInvoice",
    "getProjectInvoices", "getAllInvoices", "issueInvoice", "createRetainer",
    "updateRetainer", "deleteRetainer",
  ];
  for (const name of invoices) expectGuardBeforeDatabase(source, name, "await assertInvoicePermission(");

  const changeOrders = ["createChangeOrder", "getChangeOrders", "getChangeOrder", "deleteChangeOrder"];
  for (const name of changeOrders) expectGuardBeforeDatabase(source, name, "await assertChangeOrderPermission(");

  const projectScopedFinancialReports = [
    "getPurchaseOrders", "createPurchaseOrder", "createPurchaseOrderFromEstimate",
    "getProjectBidPackages", "createBidPackage", "updateBidPackage", "deleteBidPackage",
    "addBidScope", "deleteBidScope", "inviteSubToBid", "recordBidResponse", "awardBid",
    "getProjectPurchaseOrdersForLinking",
  ];
  for (const name of projectScopedFinancialReports) {
    expectGuardBeforeDatabase(source, name, "await assertFinancialProjectAccess(");
  }

  const entityScopedFinancialReports = [
    "getPurchaseOrder",
    "updatePurchaseOrder", "deletePurchaseOrder", "updatePurchaseOrderStatus", "approvePurchaseOrder",
    "uploadPurchaseOrderFile", "deletePurchaseOrderFile", "uploadPurchaseOrderFileFromBuffer",
    "sendPurchaseOrder", "getBidPackage", "linkPOToEstimateItem", "unlinkPOFromEstimateItem",
    "quickCreatePOAndLink",
  ];
  for (const name of entityScopedFinancialReports) {
    expectGuardBeforeDatabase(source, name, "await assertFinancialPermission(");
    expect(exportSource(source, name)).toContain("assertFinancialProjectScope(");
  }

  for (const name of ["getLeads", "getProjects", "getProject"]) {
    expectGuardBeforeDatabase(source, name, "await assertActiveStaff(");
  }

  for (const name of ["deleteLead", "updateProjectStatus", "updateProjectName", "deleteProjects"]) {
    expectGuardBeforeDatabase(source, name, "await assertActiveStaff(");
  }
  for (const name of ["saveCompanySettings", "updateCompanyProjectStatuses", "saveCompanySubcontractorTrades"]) {
    expectGuardBeforeDatabase(source, name, "await assertCompanySettingsPermission(");
  }
});

test("dual-auth financial actions keep explicit portal or machine authorization", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
  const billingCore = readFileSync(join(process.cwd(), "src/lib/billing-core.ts"), "utf8");

  expectGuardBeforeDatabase(source, "generatePdfUploadToken", "await assertEstimateStaffOrPortalAccess(");
  expectGuardBeforeDatabase(source, "ensureEstimatePayInFullSchedule", "await assertEstimateStaffOrPortalAccess(");
  expectGuardBeforeDatabase(source, "markInvoiceViewed", "await assertInvoicePortalAccess(");
  expectGuardBeforeDatabase(source, "createInvoiceFromEstimate", "await assertInvoicePermission(");
  expectGuardBeforeDatabase(source, "sendEstimateToClient", "await assertEstimateSendPermission(");
  expect(billingCore).toContain("export async function createInvoiceFromEstimateCore(");
  expect(exportSource(billingCore, "createInvoiceFromEstimateGuarded")).toContain("createInvoiceFromEstimateCore(estimateId)");
  expect(exportSource(billingCore, "createInvoiceFromEstimateGuarded")).not.toContain('import("./actions")');
});

test("standalone financial data actions enforce permission and project access", () => {
  const budgetSource = readFileSync(join(process.cwd(), "src/lib/budget-actions.ts"), "utf8");
  const timeExpenseSource = readFileSync(join(process.cwd(), "src/lib/time-expense-actions.ts"), "utf8");

  expectGuardBeforeDatabase(budgetSource, "getBudgetData", "await assertFinancialProjectAccess(");
  expectGuardBeforeDatabase(timeExpenseSource, "getTimeExpenseData", "await assertTimeExpenseProjectAccess(");
});

test("financial action payloads cannot override authorized relationship keys", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
  for (const name of ["createPurchaseOrder", "updatePurchaseOrder", "createBidPackage", "updateBidPackage", "addBidScope", "recordBidResponse"]) {
    const action = exportSource(source, name);
    expect(action, `${name} must not spread an untrusted data object into Prisma`).not.toMatch(/\.\.\.(?:data|poData)\b/);
  }
});

test("company settings split public branding from status-aware staff configuration", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
  const publicSelectStart = source.indexOf("const publicCompanySettingsSelect");
  const cachedStaffStart = source.indexOf("const getCachedCompanySettings");
  const publicGetterStart = source.indexOf("export async function getPublicCompanySettings");
  const saveStart = source.indexOf("export async function saveCompanySettings");

  expect(publicSelectStart).toBeGreaterThanOrEqual(0);
  expect(cachedStaffStart).toBeGreaterThan(publicSelectStart);
  expect(publicGetterStart).toBeGreaterThan(cachedStaffStart);
  expect(saveStart).toBeGreaterThan(publicGetterStart);
  const publicSelect = source.slice(publicSelectStart, cachedStaffStart);
  expect(publicSelect).not.toContain("googleDriveRefreshToken");
  for (const internalField of ["monthlyOverhead", "notificationEmail", "googleDriveEmail", "notificationToggles", "projectStatuses", "subcontractorTrades"]) {
    expect(publicSelect).not.toContain(internalField);
  }
  expectGuardBeforeDatabase(source, "getCompanySettings", "await assertActiveStaff(");
  expect(source.match(/getCompanySettings\(\)/g)).toHaveLength(1);
  expect(source).toContain("const settings = await getCachedCompanySettings()");
});
