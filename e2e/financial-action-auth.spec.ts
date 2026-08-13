import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canWriteDocumentTemplateType, canCreateContractFor, canAccessJobScope, canAccessContract, contractScopeWhere } from "../src/lib/access-rules";

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
  // Comments stripped for the same reason the later tests strip them: a guard
  // quoted in a comment would satisfy every indexOf below while gating nobody.
  const source = stripComments(readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8"));

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

  // Contract creation is addressed by a project/lead id alone, so it must
  // authorize before it touches either the template library or the Contract
  // table itself — not just gate "is this staff", which any anonymous caller
  // to a server action can never satisfy on its own.
  for (const name of ["createContractFromTemplate", "createContractBlank"]) {
    expectGuardBeforeDatabase(source, name, "await assertContractContextAccess(");
  }

  for (const name of ["getLeads", "getProjects", "getProject", "getClients"]) {
    expectGuardBeforeDatabase(source, name, "await assertActiveStaff(");
  }

  for (const name of ["deleteLead", "updateProjectStatus", "updateProjectName", "deleteProjects"]) {
    expectGuardBeforeDatabase(source, name, "await assertActiveStaff(");
  }
  for (const name of ["saveCompanySettings", "updateCompanyProjectStatuses", "saveCompanySubcontractorTrades"]) {
    expectGuardBeforeDatabase(source, name, "await assertCompanySettingsPermission(");
  }

  // Every assertion above only proves the guard is CALLED. A guard whose body
  // stopped throwing would satisfy all of them while authorizing nobody, so pin
  // the helper itself: resolve the staff user, and throw when there is none.
  {
    const start = source.indexOf("async function assertActiveStaff");
    expect(start, "assertActiveStaff must exist").toBeGreaterThanOrEqual(0);
    const body = source.slice(start, start + 300);
    expect(body, "assertActiveStaff must resolve the current staff user")
      .toContain("await currentStaffUserOrNull()");
    expect(body, "assertActiveStaff must throw when there is no staff user")
      .toMatch(/if\s*\(!user\)\s*throw new Error\("Unauthorized"\)/);
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

// Most of this file can only assert that guard TEXT is present in the right
// order — invert a condition inside a helper and every string match still
// passes. canCreateContractFor / canAccessJobScope live in access-rules.ts
// (pure, no Prisma or next-auth) precisely so this test can exercise real
// decisions instead of grepping for them.
test("contract creation scope is enforced, not merely present", () => {
  const admin = { role: "ADMIN", permissions: null };
  const contractsOnly = { role: "EMPLOYEE", permissions: { contracts: true } };
  const projectOnly = { role: "EMPLOYEE", permissions: { contracts: false }, projectAccess: [{ projectId: "p1" }] };
  const contractsAndProject = { role: "EMPLOYEE", permissions: { contracts: true }, projectAccess: [{ projectId: "p1" }] };
  const contractsAndLead = { role: "EMPLOYEE", permissions: { contracts: true, leadAccess: true } };
  const finance = { role: "FINANCE", permissions: null }; // default: estimates, not contracts

  // ADMIN passes for both a project scope and a lead scope — ADMIN_ROLES pass
  // canAccessProject unconditionally, and hasPermission grants every key.
  expect(canCreateContractFor(admin, { projectId: "p1" })).toBe(true);
  expect(canCreateContractFor(admin, { leadId: "l1" })).toBe(true);

  // Has `contracts` but no access to THIS project: permission alone must not
  // be enough, or any staffer holding `contracts` could target any job.
  expect(canCreateContractFor(contractsOnly, { projectId: "p1" })).toBe(false);

  // Has project access but not `contracts`: scope alone must not be enough
  // either — both halves of the AND are load-bearing.
  expect(canCreateContractFor(projectOnly, { projectId: "p1" })).toBe(false);

  // Has both: passes.
  expect(canCreateContractFor(contractsAndProject, { projectId: "p1" })).toBe(true);
  // ...but not for a DIFFERENT project it was never granted access to.
  expect(canCreateContractFor(contractsAndProject, { projectId: "p2" })).toBe(false);

  // FINANCE's role default is `estimates`, not `contracts` — exactly the
  // mislabeling this gate exists to avoid falling into.
  expect(canCreateContractFor(finance, { projectId: "p1" })).toBe(false);
  expect(canCreateContractFor({ ...finance, projectAccess: [{ projectId: "p1" }] }, { projectId: "p1" })).toBe(false);

  // Lead scope passes only with BOTH `leadAccess` and `contracts`.
  expect(canCreateContractFor(contractsAndLead, { leadId: "l1" })).toBe(true);
  expect(canCreateContractFor(contractsOnly, { leadId: "l1" })).toBe(false); // no leadAccess
  expect(canCreateContractFor({ role: "EMPLOYEE", permissions: { leadAccess: true } }, { leadId: "l1" })).toBe(false); // no contracts

  // Both ids null fails closed for EVERYONE, including ADMIN — there is
  // nothing to check access against.
  expect(canCreateContractFor(admin, {})).toBe(false);
  expect(canCreateContractFor(contractsAndProject, {})).toBe(false);

  // canAccessJobScope is the shared ownership predicate underneath — same
  // truth table, minus the `contracts` permission requirement.
  expect(canAccessJobScope(admin, { projectId: "p1" })).toBe(true);
  expect(canAccessJobScope(projectOnly, { projectId: "p1" })).toBe(true);
  expect(canAccessJobScope(projectOnly, { projectId: "p2" })).toBe(false);
  expect(canAccessJobScope({ role: "EMPLOYEE", permissions: { leadAccess: true } }, { leadId: "l1" })).toBe(true);
  expect(canAccessJobScope({ role: "EMPLOYEE", permissions: null }, { leadId: "l1" })).toBe(false);
  expect(canAccessJobScope(admin, {})).toBe(false);
});

test("contract creation is gated for staff and session-free for the shared-secret MCP caller", () => {
  const source = stripComments(readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8"));
  const core = stripComments(readFileSync(join(process.cwd(), "src/lib/contract-creation-core.ts"), "utf8"));

  // The unguarded creation body must live in a module that is not itself a
  // remotely invokable endpoint, or extracting it would simply move the hole.
  expect(core, "the core must exist").toContain("export async function createContractFromTemplateCore(");
  expect(core, "the core must exist").toContain("export async function createContractBlankCore(");
  expect(core, "the core must not be a server-action module").not.toMatch(/^\s*(['"])use server\1/m);
  expect(core, "the core must still create the contract").toContain("prisma.contract.create(");

  // Both exported actions must delegate rather than carry the body, so there is
  // exactly one creation path and it cannot drift out from under the gate.
  for (const [action, coreCall] of [
    ["createContractFromTemplate", "createContractFromTemplateCore("],
    ["createContractBlank", "createContractBlankCore("],
  ]) {
    const body = exportSource(source, action);
    const guardIndex = body.indexOf("await assertContractContextAccess(context)");
    const coreIndex = body.indexOf(coreCall);
    expect(guardIndex, `${action} must authorize the target job`).toBeGreaterThanOrEqual(0);
    expect(coreIndex, `${action} must delegate to the core`).toBeGreaterThanOrEqual(0);
    expect(guardIndex, `${action} must authorize before creating`).toBeLessThan(coreIndex);
    expect(body, `${action} must not carry the creation body itself`).not.toContain("prisma.contract.create(");
    // Same short-circuit class as the gate helper below: an early return ahead
    // of the guard leaves every ordering assertion above true and the guard
    // itself dead code.
    expect(body.slice(0, guardIndex), `${action} must not return before authorizing`)
      .not.toMatch(/\breturn\b/);
  }

  // The gate itself must pair authentication with the pure scope rule — an
  // assertActiveStaff() alone would let any staffer target any job.
  // A fixed window rather than a brace-matched one: actions.ts is mixed-EOL, so
  // a "\n}\n" sentinel silently matches nothing on the CRLF side and leaves an
  // empty string that every toContain below would fail against for the wrong
  // reason. The helper is a handful of lines; 800 chars comfortably covers it.
  const gateStart = source.indexOf("async function assertContractContextAccess(");
  expect(gateStart, "the contract gate helper must exist").toBeGreaterThanOrEqual(0);
  const gateBody = source.slice(gateStart, gateStart + 800);
  expect(gateBody, "the gate must authenticate").toContain("await assertActiveStaff()");
  expect(gateBody, "the gate must throw on a failed scope check")
    .toMatch(/if \(!canCreateContractFor\(user, scope\)\) throw new Error\(/);

  // Presence and order are not enough on their own: an early `return {} as any`
  // ahead of the checks satisfies every assertion above while authorizing
  // everybody, because the checks below it are simply never reached. Assert
  // that nothing returns before the scope check does its work — the gate's only
  // legitimate return is the trailing `return user`.
  const gateToCheck = gateBody.slice(0, gateBody.indexOf("canCreateContractFor"));
  expect(gateToCheck, "the gate must not short-circuit before the scope check")
    .not.toMatch(/\breturn\b/);

  // The MCP create_contract tool authenticates by shared secret and has no
  // NextAuth staff session, so it must reach the core directly — routing it
  // through the guarded action would break it outright.
  const mcp = stripComments(readFileSync(join(process.cwd(), "src/app/api/mcp/[transport]/route.ts"), "utf8"));
  expect(mcp, "the MCP tool must use the session-free core")
    .toContain('await import("@/lib/contract-creation-core")');
  expect(mcp, "the MCP tool must not call the session-gated action")
    .not.toMatch(/\bcreateContractFromTemplate\(|\bcreateContractBlank\(/);
});

// PR #360 gated contract CREATION. The rest of the family stayed open: every
// action below was an individually invokable POST endpoint with no session
// check at all, addressed by contract id. Reading one hands over the legal
// body, the approval IP/user-agent trail, the signature storage paths and the
// portal accessToken — which by itself authorizes a client to view AND SIGN —
// and writing one could clear a contractor signature or delete the document.
test("every exported contract action authorizes and scopes by contract id", () => {
  const source = stripComments(readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8"));

  // getContracts is the list, so it takes the where-fragment form of the same
  // rule rather than the single-row assertion; everything else is by id.
  const byId = [
    "getContract",
    "getExecutedContractPdf",
    "updateContract",
    "deleteContract",
    "getContractSigningHistory",
    "getContractSendDefaults",
  ];
  for (const name of byId) {
    const action = exportSource(source, name);
    const guardIndex = action.indexOf("await assertContractAccess(");
    expect(guardIndex, `${name} must call assertContractAccess`).toBeGreaterThanOrEqual(0);

    const databaseIndex = action.indexOf("prisma.");
    if (databaseIndex >= 0) {
      expect(guardIndex, `${name} must authorize before database access`).toBeLessThan(databaseIndex);
    }

    // Order alone is not enough: an early `return {} as any` ahead of the guard
    // satisfies every ordering assertion above while leaving the guard dead.
    const beforeGuard = action.slice(0, guardIndex);
    expect(beforeGuard, `${name} must not return before authorizing`).not.toMatch(/\breturn\b/);

    // Nor is "the guard is called" enough. Both of these satisfy every
    // assertion above and reopen the hole in full, so both are named:
    //   try { await assertContractAccess(id) } catch {}
    //   await assertContractAccess(id).catch(() => {})
    // (Codex rounds 1 and 2.)
    expect(beforeGuard, `${name} must not swallow the authorization failure`)
      .not.toMatch(/\btry\b/);
    expect(action, `${name} must not catch the authorization failure`)
      .not.toMatch(/assertContractAccess\([^)]*\)\s*\.\s*catch/);

    // And the action must still DO something after authorizing — otherwise a
    // body gutted to `return null as any` passes as "secure". Checked against
    // the FIRST statement after the guard, not merely "somewhere below it", so
    // an early return with unreachable prisma text underneath cannot satisfy
    // it (Codex round 2). This is still a source-pattern check: it raises the
    // cost of a plausible-looking regression, it does not prove behaviour.
    // Behavioural coverage would need a disposable-database request test.
    const afterGuard = action.slice(guardIndex).replace(/^[^;]*;/, "");
    expect(afterGuard.trimStart(), `${name} must still do its work after authorizing`)
      .not.toMatch(/^return\s+(null|undefined|\{\}|\[\])/);
    expect(afterGuard, `${name} must still reach the data layer`)
      .toMatch(/prisma\.|executedContractPdfFor\(/);
  }

  // The list must be filtered by the scope rule, not merely authenticated — an
  // argument-less call previously returned EVERY contract in the database.
  const list = exportSource(source, "getContracts");
  const permissionIndex = list.indexOf('await assertStaffPermission("contracts")');
  const filterIndex = list.indexOf("contractScopeWhere(user)");
  expect(permissionIndex, "getContracts must require the contracts permission").toBeGreaterThanOrEqual(0);
  expect(filterIndex, "getContracts must apply the contract scope filter").toBeGreaterThanOrEqual(0);
  expect(permissionIndex, "getContracts must authenticate before querying")
    .toBeLessThan(list.indexOf("prisma."));
  expect(list.slice(0, permissionIndex), "getContracts must not return before authorizing")
    .not.toMatch(/\breturn\b/);

  // getExecutedContractPdf used to trust a caller-supplied {projectId, leadId,
  // title} descriptor, so naming another job's ids returned that job's file.
  // Only the id may be read off the argument now; the rest comes from the row.
  const pdf = exportSource(source, "getExecutedContractPdf");
  for (const trusted of ["contract.projectId", "contract.leadId", "contract.title"]) {
    expect(pdf, `getExecutedContractPdf must not trust the caller's ${trusted}`).not.toContain(trusted);
  }
  expect(pdf, "getExecutedContractPdf must delegate the lookup to the core")
    .toContain("executedContractPdfFor(");

  // Gating the by-id actions is not enough while a differently named action
  // returns the same rows. getLead embeds the lead's contracts and resolves its
  // caller with currentStaffUserOrNull(), which returns null rather than
  // throwing — so an unscoped `contracts: true` handed an anonymous caller the
  // legal body, the signatures and the signing accessToken (Codex round-1
  // blocker). The relation carries the list filter, exactly as the estimates
  // relation beside it does.
  const lead = exportSource(source, "getLead");
  expect(lead, "getLead must scope the contracts it embeds")
    .toMatch(/contracts: \{ where: contractScopeWhere\(user\) \}/);
  expect(lead, "getLead must not embed contracts unscoped").not.toMatch(/contracts: true/);
});

// The live staff contract screens do NOT go through getContracts — they query
// Prisma directly, so securing the action alone secured nothing a user actually
// loads. Their layouts check project access / leadAccess but never `contracts`.
test("the staff contract pages filter by the same scope rule the actions assert", () => {
  for (const page of [
    "src/app/projects/[id]/contracts/page.tsx",
    "src/app/leads/[id]/contracts/page.tsx",
  ]) {
    const source = stripComments(readFileSync(join(process.cwd(), page), "utf8"));
    // currentStaffUserOrNull, NOT the bare getCurrentUserWithPermissions: the
    // surrounding layouts and actions honour the development ADMIN fallback,
    // so the bare form would render an empty contract list in sessionless
    // local development while everything around it worked (Codex round 2).
    expect(source, `${page} must resolve the viewer`).toContain("await currentStaffUserOrNull()");
    expect(source, `${page} must apply the contract scope filter`).toContain("contractScopeWhere(viewer)");

    // The filter must gate the contract query itself, not sit unused beside it.
    const queryIndex = source.indexOf("prisma.contract.findMany(");
    const filterIndex = source.indexOf("contractScopeWhere(viewer)");
    expect(queryIndex, `${page} must still query contracts`).toBeGreaterThanOrEqual(0);
    expect(filterIndex, `${page} must apply the filter inside the query`).toBeGreaterThan(queryIndex);
    expect(filterIndex - queryIndex, `${page} must apply the filter to the contract query`).toBeLessThan(200);
  }
});

test("the contract gate pairs the contracts permission with the job-scope rule", () => {
  const source = stripComments(readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8"));

  // Fixed windows rather than brace-matched ones: actions.ts is mixed-EOL, so a
  // "\n}\n" sentinel silently matches nothing on the CRLF side and leaves an
  // empty string that every assertion below would fail against for the wrong
  // reason.
  const gateStart = source.indexOf("async function assertContractAccess(");
  expect(gateStart, "the contract gate helper must exist").toBeGreaterThanOrEqual(0);
  const gate = source.slice(gateStart, gateStart + 800);
  expect(gate, "the gate must require the contracts permission")
    .toContain('await assertStaffPermission("contracts")');
  expect(gate, "the gate must resolve the owner from the database, not the caller")
    .toContain("await contractOwnerOrThrow(contractId)");
  expect(gate, "the gate must apply the scope check").toContain("assertContractScope(user, contract)");

  // Permission BEFORE the lookup, so "Contract not found" vs "Forbidden" cannot
  // be used as an existence oracle by a caller holding no contract permission.
  expect(gate.indexOf('await assertStaffPermission("contracts")'))
    .toBeLessThan(gate.indexOf("await contractOwnerOrThrow(contractId)"));

  // Nothing may short-circuit ahead of the scope check.
  expect(gate.slice(0, gate.indexOf("assertContractScope(user, contract)")),
    "the gate must not return before the scope check").not.toMatch(/\breturn\b/);

  const scopeStart = source.indexOf("function assertContractScope(");
  expect(scopeStart, "the scope helper must exist").toBeGreaterThanOrEqual(0);
  const scope = source.slice(scopeStart, scopeStart + 800);
  expect(scope, "the scope check must fail closed on an ownerless contract")
    .toMatch(/if \(!scope\.projectId && !scope\.leadId\) \{\s*throw new Error\(/);
  expect(scope, "the scope check must throw on a failed decision")
    .toMatch(/if \(!canAccessContract\(user, scope\)\) throw new Error\(/);
  expect(scope.slice(0, scope.indexOf("canAccessContract")),
    "the scope check must not return before deciding").not.toMatch(/\breturn\b/);

  // The client portal has no staff session — it proves access with the emailed
  // accessToken or a portal session resolving to the owning Client — so it must
  // reach the session-free core. Routing it through the gated action would
  // break the client's download of their own executed contract outright.
  const core = stripComments(readFileSync(join(process.cwd(), "src/lib/contract-files-core.ts"), "utf8"));
  expect(core, "the core must exist").toContain("export async function executedContractPdfFor(");
  expect(core, "the core must not be a server-action module").not.toMatch(/^\s*(['"])use server\1/m);
  expect(core, "the core must still perform the lookup").toContain("prisma.projectFile.findFirst(");

  const portal = stripComments(readFileSync(join(process.cwd(), "src/app/portal/contracts/[id]/page.tsx"), "utf8"));
  expect(portal, "the portal must prove ownership first").toContain("getContractForPortal(");
  expect(portal, "the portal must use the session-free core")
    .toContain('from "@/lib/contract-files-core"');
  expect(portal, "the portal must not call the staff-gated action")
    .not.toMatch(/\bgetExecutedContractPdf\(/);
});

// Same reasoning as the creation truth table above: the tests either side of
// this one can only assert that guard TEXT appears in the right order, and
// inverting a condition inside canAccessContract would leave every one of them
// passing. contractScopeWhere is checked against the same decisions so the list
// and the detail page cannot drift apart.
test("contract read/write scope is enforced, not merely present", () => {
  const admin = { role: "ADMIN", permissions: null };
  const contractsOnly = { role: "EMPLOYEE", permissions: { contracts: true } };
  const projectOnly = { role: "EMPLOYEE", permissions: { contracts: false }, projectAccess: [{ projectId: "p1" }] };
  const contractsAndProject = { role: "EMPLOYEE", permissions: { contracts: true }, projectAccess: [{ projectId: "p1" }] };
  const contractsAndLead = { role: "EMPLOYEE", permissions: { contracts: true, leadAccess: true } };
  const finance = { role: "FINANCE", permissions: null }; // default: estimates, not contracts

  expect(canAccessContract(admin, { projectId: "p1" })).toBe(true);
  expect(canAccessContract(admin, { leadId: "l1" })).toBe(true);

  // Both halves of the AND are load-bearing, exactly as for creation.
  expect(canAccessContract(contractsOnly, { projectId: "p1" })).toBe(false);
  expect(canAccessContract(projectOnly, { projectId: "p1" })).toBe(false);
  expect(canAccessContract(contractsAndProject, { projectId: "p1" })).toBe(true);
  expect(canAccessContract(contractsAndProject, { projectId: "p2" })).toBe(false);

  // The getContractSendDefaults fix in one line: FINANCE used to pass a
  // hard-coded role list and read any job's client + manager emails.
  expect(canAccessContract(finance, { projectId: "p1" })).toBe(false);
  expect(canAccessContract({ ...finance, projectAccess: [{ projectId: "p1" }] }, { projectId: "p1" })).toBe(false);

  expect(canAccessContract(contractsAndLead, { leadId: "l1" })).toBe(true);
  expect(canAccessContract(contractsOnly, { leadId: "l1" })).toBe(false);
  expect(canAccessContract({ role: "EMPLOYEE", permissions: { leadAccess: true } }, { leadId: "l1" })).toBe(false);

  // Ownerless fails closed for everyone, ADMIN included.
  expect(canAccessContract(admin, {})).toBe(false);
  expect(canAccessContract(contractsAndProject, {})).toBe(false);

  // Reading is gated exactly as tightly as creating — the accessToken a read
  // returns authorizes signing, so a looser read rule would be the bigger hole.
  for (const user of [admin, contractsOnly, projectOnly, contractsAndProject, contractsAndLead, finance]) {
    for (const scope of [{ projectId: "p1" }, { projectId: "p2" }, { leadId: "l1" }, {}]) {
      expect(canAccessContract(user as any, scope), `${user.role} vs ${JSON.stringify(scope)}`)
        .toBe(canCreateContractFor(user as any, scope));
    }
  }

  // The list filter must mirror the single-row rule branch for branch.
  const matchesNothing = { id: { in: [] as string[] } };
  expect(contractScopeWhere(null)).toEqual(matchesNothing);
  expect(contractScopeWhere(undefined)).toEqual(matchesNothing);
  // Authenticated but without `contracts`: matches nothing, not everything.
  expect(contractScopeWhere(projectOnly)).toEqual(matchesNothing);
  expect(contractScopeWhere(finance)).toEqual(matchesNothing);
  expect(contractScopeWhere(contractsOnly)).toEqual(matchesNothing); // permission, no scope

  // ADMIN sees every ATTACHED contract — never the ownerless ones, because
  // canAccessContract rejects those for every role.
  expect(contractScopeWhere(admin)).toEqual({
    OR: [{ projectId: { not: null } }, { leadId: { not: null } }],
  });
  expect(contractScopeWhere(contractsAndProject)).toEqual({ OR: [{ projectId: { in: ["p1"] } }] });
  expect(contractScopeWhere(contractsAndLead)).toEqual({
    OR: [{ projectId: null, leadId: { not: null } }],
  });
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

test("pages that sum scoped estimates label the total by what the reader can see", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
  const projectsPage = readFileSync(join(process.cwd(), "src/app/projects/page.tsx"), "utf8");
  const projectsClient = readFileSync(join(process.cwd(), "src/app/projects/ProjectsClient.tsx"), "utf8");
  const leadEstimates = readFileSync(join(process.cwd(), "src/app/leads/[id]/estimates/page.tsx"), "utf8");

  // Estimate READS are scoped per caller; the project LIST is not. So a card
  // summing embedded estimates can hold a partial number under a label that
  // claims the whole company. The number stays scoped — the label must move.
  // NOTE ON REACH: like the rest of this spec these are source assertions, so
  // they prove the data PATH, not the runtime value — the decision itself is
  // verified behaviourally in estimate-scope-rules.spec.ts. What they must
  // therefore rule out is the hardcode: an action that authenticates and then
  // returns a literal, or a page that computes the flag and passes a constant.
  {
    const action = exportSource(source, "estimateTotalsComplete");
    expect(action, "the completeness reader must authenticate first")
      .toContain("await assertActiveStaff()");
    expect(action, "it must RETURN the shared rule's answer, not a literal")
      .toMatch(/return estimateTotalsAreComplete\(user, owners\);/);
    expect(action, "it must not short-circuit to a constant verdict")
      .not.toMatch(/return (true|false)\b/);
  }

  // Both readers must ASK, naming the owners their aggregate actually covered.
  expect(projectsPage, "the projects page must ask whether its revenue sum is complete")
    .toMatch(/const revenueIsComplete = await estimateTotalsComplete\(projects\.map/);
  expect(projectsPage, "the answer must reach the client, not a literal")
    .toContain("revenueIsComplete={revenueIsComplete}");
  expect(leadEstimates, "the lead estimates page must ask over its lead and its linked project")
    .toMatch(/const totalsAreComplete = await estimateTotalsComplete\(/);
  expect(leadEstimates, "the lead's own estimates must be asked about as a lead, not as a null project")
    .toMatch(/\{ leadId: lead\.id \}/);

  // ...and must USE the answer. A page could import it and still print the
  // unconditional label, which is the exact bug this pair of assertions guards.
  expect(projectsClient, "the revenue label must depend on completeness")
    .toMatch(/revenueIsComplete \?[^\n]*Total Revenue/);
  expect(projectsClient, "revenueIsComplete must be a required prop, so a caller cannot omit it")
    .toMatch(/revenueIsComplete: boolean/);
  for (const claim of ["Across all estimates", "Total created"]) {
    expect(leadEstimates, `"${claim}" must be conditional on completeness`)
      .toMatch(new RegExp(`totalsAreComplete \\?[^\\n]*${claim}`));
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
