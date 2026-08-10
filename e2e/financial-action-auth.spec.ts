import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canWriteDocumentTemplateType } from "../src/lib/access-rules";

function exportSource(source: string, name: string): string {
  const marker = new RegExp(`export\\s+(?:async function|const)\\s+${name}\\b`);
  const match = marker.exec(source);
  expect(match, `${name} must remain exported`).not.toBeNull();
  const start = match!.index;
  const remainder = source.slice(start + match![0].length);
  const next = /\nexport\s+(?:async function|const)\s+/.exec(remainder);
  return source.slice(start, next ? start + match![0].length + next.index : undefined);
}

// Comments are not code. `expectGuardBeforeDatabase` matches with indexOf, so a
// guard that has been commented out — or a comment that merely quotes the guard
// it is describing — would satisfy a textual assertion while authorizing
// nobody. Blank the comments out (preserving newlines and length so any offset
// comparison still lines up with the real source) before asserting.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
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
    // The decision itself lives in access-rules.ts and is behaviourally tested
    // by estimate-scope-rules.spec.ts; what must hold HERE is that the
    // assertion still delegates to it rather than re-deciding locally.
    assertEstimateScope: ["canAccessEstimate(", "throw new Error"],
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
  // getAllEstimates is NOT in this list — it lists per-job documents, and is
  // covered by the list-scoping test below.
  const companyWideEstimateActions = [
    "getEstimateTemplates", "saveItemsAsAssembly", "deleteAssembly",
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

test("estimate readers filter by the same scope the detail page asserts", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
  const permissions = readFileSync(join(process.cwd(), "src/lib/permissions.ts"), "utf8");

  // A list that returns rows whose detail page throws Forbidden is its own bug.
  // Every reader that returns estimates must apply the filter form of the same
  // rule assertEstimateScope applies to a single row.
  {
    const action = exportSource(source, "getAllEstimates");
    const guardIndex = action.indexOf("await assertEstimatePermission(");
    const filterIndex = action.indexOf("where: estimateScopeWhere(user)");
    const databaseIndex = action.indexOf("prisma.");
    expect(guardIndex, "getAllEstimates must assert the estimates permission").toBeGreaterThanOrEqual(0);
    expect(filterIndex, "getAllEstimates must scope the list, not just gate the permission").toBeGreaterThanOrEqual(0);
    expect(guardIndex, "getAllEstimates must authorize before database access").toBeLessThan(databaseIndex);
  }

  // The staff branch of the portal preview used to fetch any id by id alone.
  {
    const action = exportSource(source, "getEstimateForPortal");
    expect(action, "the staff preview branch must be scoped")
      .toContain("const staffFilter = { AND: [{ id }, estimateScopeWhere(staffUser)] }");
    expect(action, "the staff preview must not fall back to an unscoped fetch by id")
      .not.toMatch(/where: \{ id \},/);
    // Both the primary query and its degraded fallback must use it — the
    // fallback runs on exactly the error paths nobody exercises by hand.
    expect(action.match(/where: staffFilter/g) ?? [], "both staff queries must use the scoped filter").toHaveLength(2);
  }

  // Nested embeds are the same exposure by another route: a lead or project
  // getter that includes estimates hands back rows the caller may not open.
  for (const name of ["getLeads", "getLead", "getProjects", "getProject"]) {
    expect(exportSource(source, name), `${name} must scope the estimates it embeds`)
      .toContain("scopedEstimateRelation(");
  }
  // getClients is the other way to satisfy the rule: it embeds no estimates at
  // all. Nothing on the contacts page or the client picker ever read them, so
  // the safest scope filter is not fetching the rows in the first place.
  //
  // Assert the positive shape as well as the absence. The negative alone is
  // satisfied by any rewrite that stops naming the key — a nested `include`
  // that pulls whole project rows would pass it while re-opening the
  // over-fetch. Pinning the projects relation to an id-only select is what
  // actually leaves no room for an estimates embed to come back.
  {
    const action = exportSource(source, "getClients");
    // Tolerate reformatting: `estimates :`, `"estimates":`, newline-separated.
    expect(action, "getClients must not embed estimates")
      .not.toMatch(/["']?estimates["']?\s*:/);
    expect(action, "getClients must select only project ids")
      .toMatch(/projects\s*:\s*\{\s*select\s*:\s*\{\s*id\s*:\s*true\s*,?\s*\}\s*,?\s*\}/);
  }
  expect(source, "no estimates relation may be embedded without the scope filter")
    .not.toMatch(/estimates: safeEstimateInclude/);

  // The relation wrapper must apply the predicate, not an empty where — every
  // nested-embed assertion above would still pass if it returned `where: {}`.
  const relationStart = source.indexOf("function scopedEstimateRelation");
  expect(relationStart, "scopedEstimateRelation must exist").toBeGreaterThanOrEqual(0);
  expect(
    source.slice(relationStart, relationStart + 400),
    "scopedEstimateRelation must apply estimateScopeWhere to the relation",
  ).toContain("where: estimateScopeWhere(user)");

  // Agreement is structural, not coincidental. Both forms of the rule are
  // defined in access-rules.ts and are behaviourally verified against each
  // other over a truth table in estimate-scope-rules.spec.ts; what must hold
  // here is that actions.ts keeps delegating to them instead of re-deciding.
  expect(
    source.slice(source.indexOf("function assertEstimateScope(")),
    "assertEstimateScope must delegate to the shared rule",
  ).toContain("canAccessEstimate(user, scope)");
  expect(permissions, "permissions.ts must re-export the shared rules, not redefine them")
    .toMatch(/export \{[\s\S]{0,400}canAccessEstimate,[\s\S]{0,200}estimateScopeWhere,[\s\S]{0,200}\} from "\.\/access-rules"/);
  expect(source, "actions.ts must not keep a private copy of the scope predicate")
    .not.toMatch(/\nfunction estimateScopeWhere\(/);

  // The reader that has no throwing assertion of its own must not swallow
  // infrastructure failures — an outage rendered as "no estimates" is a page
  // of plausible zeroes, not an error.
  const resolverStart = source.indexOf("async function currentStaffUserOrNull(");
  expect(resolverStart, "currentStaffUserOrNull must exist").toBeGreaterThanOrEqual(0);
  const resolver = source.slice(resolverStart, source.indexOf("async function assertActiveStaff("));
  expect(resolver, "currentStaffUserOrNull must not catch and flatten errors").not.toContain("catch");
});
test("document template CRUD authorizes reads and writes", () => {
  const source = stripComments(readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8"));

  // These templates hold the terms & conditions snapshotted onto estimates and
  // contracts when they are sent, so an unauthenticated write edits the legal
  // text on future client-facing documents. Company-wide, hence no per-project
  // scope — but never open.
  for (const name of ["getDocumentTemplates", "getDocumentTemplate"]) {
    expectGuardBeforeDatabase(source, name, "await assertDocumentTemplateReadAccess(");
  }
  for (const name of ["createDocumentTemplate", "updateDocumentTemplate", "deleteDocumentTemplate"]) {
    expectGuardBeforeDatabase(source, name, "await assertDocumentTemplateWritePermission(");
  }

  // The permission alone is not the whole write gate: `estimates` is accepted
  // so estimators can author terms/overview/notes, so every write must ALSO
  // scope the type or an estimates-only user (the FINANCE default) could
  // rewrite contract and lien-release language.
  for (const name of ["createDocumentTemplate", "updateDocumentTemplate", "deleteDocumentTemplate"]) {
    expect(exportSource(source, name), `${name} must scope the template type`)
      .toContain("assertDocumentTemplateTypeScope(");
  }

  // Ordering: EVERY scope call must precede the write, so the last one is the
  // one to compare — checking only the first would let a retype check drift
  // below the mutation and still pass.
  {
    const create = exportSource(source, "createDocumentTemplate");
    expect(create.lastIndexOf("assertDocumentTemplateTypeScope("), "type scope must precede the create")
      .toBeLessThan(create.indexOf("prisma.documentTemplate."));
  }
  {
    const update = exportSource(source, "updateDocumentTemplate");
    expect(update, "updateDocumentTemplate must scope the row's existing type")
      .toContain("assertDocumentTemplateTypeScope(user, existing.type)");
    expect(update, "updateDocumentTemplate must scope an incoming retype")
      .toContain("assertDocumentTemplateTypeScope(user, data.type)");
    expect(update.lastIndexOf("assertDocumentTemplateTypeScope("), "every type scope must precede the write")
      .toBeLessThan(update.indexOf("tx.documentTemplate.updateMany("));
    // The authorized type must be re-asserted by the write itself — a
    // concurrent retype must not hand this caller a protected row.
    expect(update, "the update must pin the authorized type in its own filter")
      .toContain("where: { id, type: existing.type }");
    expect(update, "a lost type pin must refuse, not silently no-op")
      .toMatch(/claimed\.count === 0[\s\S]{0,80}throw new Error/);
  }
  {
    const del = exportSource(source, "deleteDocumentTemplate");
    expect(del.lastIndexOf("assertDocumentTemplateTypeScope("), "type scope must precede the delete")
      .toBeLessThan(del.indexOf("prisma.documentTemplate.deleteMany("));
    expect(del, "the delete must pin the authorized type in its own filter")
      .toContain("where: { id, type: existing.type }");
    expect(del, "a lost type pin must refuse, not silently no-op")
      .toMatch(/removed\.count === 0[\s\S]{0,80}throw new Error/);
  }

  // The scope helper must actually delegate to the real predicate and throw.
  const scopeStart = source.indexOf("function assertDocumentTemplateTypeScope(");
  expect(scopeStart, "assertDocumentTemplateTypeScope must exist").toBeGreaterThanOrEqual(0);
  const scopeBody = source.slice(scopeStart, scopeStart + 300);
  expect(scopeBody).toContain("canWriteDocumentTemplateType(user, type)");
  expect(scopeBody).toContain("throw new Error");

  // The helpers must keep doing the work — otherwise the assertions above pass
  // against a gutted no-op.
  const helperBodies: Record<string, string[]> = {
    assertDocumentTemplateReadAccess: [
      "await assertActiveStaff()", 'hasPermission(user, "estimates")',
      'hasPermission(user, "contracts")', 'hasPermission(user, "companySettings")', "throw new Error",
    ],
    assertDocumentTemplateWritePermission: [
      "await assertActiveStaff()", 'hasPermission(user, "companySettings")',
      'hasPermission(user, "estimates")', "throw new Error",
    ],
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

  // Field crew have none of the three permissions, and the /templates hub is a
  // plain nav page for any staffer — its count read must stay fail-soft rather
  // than throwing them into the route error boundary.
  const hub = readFileSync(join(process.cwd(), "src/app/templates/page.tsx"), "utf8");
  expect(hub, "the templates hub must tolerate a forbidden template read")
    .toMatch(/getDocumentTemplates\(\)\.catch\(/);
});

// Most of this file can only assert that guard TEXT is present in the right
// order — invert a condition inside a helper and every string match still
// passes. The template type rule lives in access-rules.ts (pure, no Prisma or
// next-auth) precisely so this one can be executed against real decisions.
test("document template type scope is enforced, not merely present", () => {
  const u = (role: string, permissions: any = null) => ({ role, permissions });
  const ESTIMATOR_TYPES = ["terms", "overview", "notes"];
  const PROTECTED_TYPES = ["contract", "lien_release", "warranty", "addendum", "disclaimer", "change_order", "draw_request", "punch_list"];

  for (const type of [...ESTIMATOR_TYPES, ...PROTECTED_TYPES]) {
    // companySettings owns the whole library; ADMIN/MANAGER hold every key.
    expect(canWriteDocumentTemplateType(u("ADMIN"), type), `ADMIN must write ${type}`).toBe(true);
    expect(canWriteDocumentTemplateType(u("MANAGER"), type), `MANAGER must write ${type}`).toBe(true);
    expect(canWriteDocumentTemplateType(u("FINANCE", { companySettings: true }), type)).toBe(true);
    // No relevant permission at all is always a refusal.
    expect(canWriteDocumentTemplateType(u("FIELD_CREW"), type), `FIELD_CREW must not write ${type}`).toBe(false);
    expect(canWriteDocumentTemplateType(u("EMPLOYEE"), type), `EMPLOYEE must not write ${type}`).toBe(false);
  }

  // FINANCE defaults to estimates-without-companySettings — the exact role this
  // scope exists to contain, asserted against the real default table.
  for (const type of ESTIMATOR_TYPES) {
    expect(canWriteDocumentTemplateType(u("FINANCE"), type), `FINANCE may author ${type}`).toBe(true);
  }
  for (const type of PROTECTED_TYPES) {
    expect(canWriteDocumentTemplateType(u("FINANCE"), type), `FINANCE must NOT rewrite ${type}`).toBe(false);
  }

  // An explicit grant behaves the same as the role default, in both directions.
  expect(canWriteDocumentTemplateType(u("FIELD_CREW", { estimates: true }), "terms")).toBe(true);
  expect(canWriteDocumentTemplateType(u("FIELD_CREW", { estimates: true }), "contract")).toBe(false);
  expect(canWriteDocumentTemplateType(u("FINANCE", { estimates: false }), "terms")).toBe(false);

  // Malformed and near-miss types fail closed rather than matching loosely.
  for (const bad of [null, undefined, "", "TERMS", "terms ", "unknown_type"]) {
    expect(canWriteDocumentTemplateType(u("FINANCE"), bad as any), `must fail closed on ${JSON.stringify(bad)}`).toBe(false);
  }
});

test("lead → project conversion is gated for staff and session-free for pre-authorized callers", () => {
  const source = stripComments(readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8"));
  const core = stripComments(readFileSync(join(process.cwd(), "src/lib/lead-conversion-core.ts"), "utf8"));

  // The conversion moves every estimate off a lead and onto a brand new
  // project, so the exported Server Action must authorize before it runs, and
  // the unguarded body must live in a module that is not itself a remotely
  // invokable endpoint.
  const action = exportSource(source, "convertLeadToProject");
  const authIndex = action.indexOf("await assertActiveStaff()");
  // The whole conditional, not just the call: a bare `hasPermission(...)` whose
  // result is discarded reads like a guard and enforces nothing.
  const permIndex = action.search(/if \(!hasPermission\(user, "leadAccess"\)\) throw new Error\(/);
  const coreIndex = action.indexOf("convertLeadToProjectCore(leadId)");
  expect(authIndex, "convertLeadToProject must authenticate").toBeGreaterThanOrEqual(0);
  expect(permIndex, "convertLeadToProject must throw when leadAccess is missing").toBeGreaterThanOrEqual(0);
  expect(coreIndex, "convertLeadToProject must delegate to the core").toBeGreaterThanOrEqual(0);
  expect(authIndex, "authentication must precede the conversion").toBeLessThan(coreIndex);
  expect(permIndex, "the permission check must precede the conversion").toBeLessThan(coreIndex);
  expect(action, "the exported action must not carry the conversion body itself")
    .not.toContain("prisma.$transaction");

  expect(core, "the core must exist").toContain("export async function convertLeadToProjectCore(");
  // Either quote spelling turns this file into a server-action module and would
  // re-expose the unguarded body as a remote endpoint.
  expect(core, "the core must not be a server-action module").not.toMatch(/^\s*(['"])use server\1/m);
  expect(core, "the core must still perform the conversion").toContain("prisma.$transaction");

  // Portal approval already proved client ownership via resolveSessionClientId,
  // and a portal client is not staff — it must call the core, not the gate.
  const postApproval = source.slice(source.indexOf("async function ensureProjectAndDepositInvoiceForEstimate("));
  const postApprovalBody = postApproval.slice(0, postApproval.indexOf("\nexport "));
  expect(postApprovalBody, "portal approval must use the session-free core")
    .toContain("convertLeadToProjectCore(estimate.leadId)");

  // approveEstimate's own ownership check must survive untouched.
  const approve = exportSource(source, "approveEstimate");
  expect(approve, "approveEstimate must still resolve the portal client").toContain("resolveSessionClientId(");

  // createProject builds a Client and a Lead before converting — it cannot be
  // left open either.
  expectGuardBeforeDatabase(source, "createProject", "await assertActiveStaff(");

  // /api/manager/jobs authenticates a mobile token OR a session and then runs
  // assertLeadAccess; a mobile-token caller has no NextAuth staff session, so it
  // must go through the core with its own gate intact.
  const jobsRoute = stripComments(readFileSync(join(process.cwd(), "src/app/api/manager/jobs/route.ts"), "utf8"));
  const routeAccess = jobsRoute.indexOf("await assertLeadAccess(user, leadId)");
  const routeConvert = jobsRoute.indexOf("convertLeadToProjectCore(leadId)");
  expect(routeConvert, "the manager jobs route must use the core").toBeGreaterThanOrEqual(0);
  expect(routeAccess, "the manager jobs route must keep its own lead-access check").toBeGreaterThanOrEqual(0);
  expect(routeAccess, "lead access must be checked before the conversion runs").toBeLessThan(routeConvert);
  // assertLeadAccess RETURNS the denial rather than throwing, so ignoring the
  // return value would leave the check decorative.
  expect(jobsRoute, "the manager jobs route must return the lead-access denial")
    .toMatch(/const accessError = await assertLeadAccess\(user, leadId\);[\s\S]{0,120}if \(accessError\) return accessError;/);
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
