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

  // The `estimates` permission answers "may this user touch estimates at all",
  // NOT "may this user touch THIS estimate". Every action addressed by an
  // estimate / project / lead / item id must therefore use the SCOPED helper,
  // which pairs the permission with canAccessProject (or `leadAccess` for
  // lead-owned estimates). Only the genuinely company-wide actions — the
  // template and assembly library — may keep the bare permission gate.
  const estimateScopeGuards: Record<string, string> = {
    getEstimate: "await assertEstimateAccess(",
    getEstimateActivity: "await assertEstimateAccess(",
    saveEstimate: "await assertEstimateAccess(",
    logEstimatePayment: "await assertEstimateAccess(",
    archiveEstimate: "await assertEstimateAccess(",
    deleteEstimate: "await assertEstimateAccess(",
    duplicateEstimate: "await assertEstimateAccess(",
    saveEstimateAsTemplate: "await assertEstimateAccess(",
    importEstimateToSchedule: "await assertEstimateAccess(",
    uploadEstimateFile: "await assertEstimateAccess(",
    getEstimateFiles: "await assertEstimateAccess(",
    updateEstimateStatus: "await assertEstimateAccess(",
    createDraftEstimate: "await assertEstimateProjectAccess(",
    createEstimateFromTemplate: "await assertEstimateProjectAccess(",
    getEstimateItemsForProject: "await assertEstimateProjectAccess(",
    addVoiceEstimateItem: "await assertEstimateProjectAccess(",
    createDraftLeadEstimate: "await assertEstimateLeadAccess(",
    updateItemApproval: "await assertEstimateItemAccess(",
    bulkUpdateItemApproval: "await assertEstimateItemAccess(",
    sendEstimatePaymentReceipt: "await assertEstimatePaymentAccess(",
  };
  for (const [name, guard] of Object.entries(estimateScopeGuards)) {
    expectGuardBeforeDatabase(source, name, guard);
  }

  // Two-id actions: the estimate is scoped, and the milestone must be resolved
  // THROUGH that estimate — both before the mutating transaction opens, or the
  // authorization is decorative.
  for (const name of ["recordEstimatePayment", "unrecordEstimatePayment"]) {
    const action = exportSource(source, name);
    const scopeIndex = action.indexOf("await assertEstimateAccess(");
    const pairIndex = action.indexOf("await assertPaymentBelongsToEstimate(");
    const txIndex = action.indexOf("withTxRetry(");
    expect(scopeIndex, `${name} must scope the estimate`).toBeGreaterThanOrEqual(0);
    expect(pairIndex, `${name} must pair the milestone to the estimate`).toBeGreaterThanOrEqual(0);
    expect(txIndex, `${name} must still open a transaction`).toBeGreaterThanOrEqual(0);
    expect(scopeIndex, `${name} must authorize before the transaction`).toBeLessThan(txIndex);
    expect(pairIndex, `${name} must pair before the transaction`).toBeLessThan(txIndex);
  }

  // The helpers themselves must keep doing the work. Without this, any caller
  // assertion above still passes while the helper it names is gutted to a no-op.
  const helperBodies: Record<string, string[]> = {
    assertEstimateScope: ["canAccessProject(", 'hasPermission(user, "leadAccess")', "throw new Error"],
    assertEstimateAccess: ["assertEstimatePermission(", "assertEstimateScope("],
    assertEstimateProjectAccess: ["assertEstimatePermission(", "assertEstimateScope("],
    assertEstimateLeadAccess: ["assertEstimatePermission(", "assertEstimateScope("],
    assertEstimateItemAccess: ["assertEstimatePermission(", "assertEstimateScope("],
    assertEstimatePaymentAccess: ["assertEstimatePermission(", "assertEstimateScope("],
    assertPaymentBelongsToEstimate: ["where: { id: paymentId, estimateId }", "throw new Error"],
    assertEstimateStaffOrPortalAccess: ["assertEstimateScope(", "resolveSessionClientId("],
  };
  for (const [helper, required] of Object.entries(helperBodies)) {
    const start = source.indexOf(`function ${helper}(`);
    expect(start, `${helper} must exist`).toBeGreaterThanOrEqual(0);
    const nextFn = /\nasync function |\nfunction |\nexport /.exec(source.slice(start + helper.length));
    const body = source.slice(start, nextFn ? start + helper.length + nextFn.index : undefined);
    for (const needle of required) {
      expect(body, `${helper} must still contain ${needle}`).toContain(needle);
    }
  }

  // An ownerless estimate must fail closed, not be authorized by default.
  expect(
    source.slice(source.indexOf("function assertEstimateScope(")),
    "assertEstimateScope must reject an estimate with neither project nor lead",
  ).toMatch(/if \(!scope\.projectId && !scope\.leadId\)[\s\S]{0,200}throw new Error/);

  // Addressed by a non-estimate id, so the owner is resolved first and the
  // shared scope predicate applied to the loaded row.
  for (const name of ["deleteEstimateFile", "createEstimateFromRoomDesign"]) {
    expectGuardBeforeDatabase(source, name, "await assertEstimatePermission(");
    expect(exportSource(source, name), `${name} must apply the estimate scope check`)
      .toContain("assertEstimateScope(");
  }

  expectGuardBeforeDatabase(source, "createInvoiceFromEstimate", "await assertInvoicePermission(");
  expect(exportSource(source, "createInvoiceFromEstimate")).toContain("assertEstimateScope(");

  // Company-wide by design: the template/assembly library is not per-job.
  const companyWideEstimateActions = [
    "getAllEstimates", "getEstimateTemplates", "saveItemsAsAssembly", "deleteAssembly",
  ];
  for (const name of companyWideEstimateActions) {
    expectGuardBeforeDatabase(source, name, "await assertEstimatePermission(");
  }

  const invoices = [
    "deleteInvoice", "updateInvoiceNotes", "createInvoiceFromTimeEntries", "getInvoice",
    "getProjectInvoices", "getAllInvoices", "issueInvoice", "createRetainer",
    "updateRetainer", "deleteRetainer",
  ];
  for (const name of invoices) expectGuardBeforeDatabase(source, name, "await assertInvoicePermission(");

  const changeOrders = ["createChangeOrder", "getChangeOrders", "getChangeOrder", "deleteChangeOrder"];
  for (const name of changeOrders) expectGuardBeforeDatabase(source, name, "await assertChangeOrderPermission(");

  // createChangeOrder copies a source estimate's priced items into a
  // destination project. Both ends need scoping, and the two ids must be
  // required to belong together.
  {
    const action = exportSource(source, "createChangeOrder");
    expect(action, "createChangeOrder must scope the destination project")
      .toContain("assertEstimateScope(user, { projectId })");
    expect(action, "createChangeOrder must load the estimate scoped to that project")
      .toContain("where: { id: estimateId, projectId }");
  }

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
