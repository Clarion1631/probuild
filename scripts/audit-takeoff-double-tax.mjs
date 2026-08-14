// READ-ONLY audit of estimates converted from an AI takeoff that carry sales tax
// INSIDE their line items while still presenting as untaxed.
//
// Background: the AI takeoff prompt emits WA sales tax as its own line item
// (cost code `99-TAX`) and reports a TAX-INCLUSIVE `totalEstimate`.
// `convert-to-estimate` stored that total on the Estimate but never set
// `taxRatePercent`. Downstream a null `taxRatePercent` means "this total is
// tax-EXCLUSIVE" — the portal display adds the default rate on top of a subtotal
// that already contains the 99-TAX row, and `ensureProjectAndDepositInvoiceForEstimate`
// grosses `totalAmount` / `balanceDue` / pending milestones up by that rate at
// approval. Either way the client sees and signs tax charged twice.
//
// THIS SCRIPT NEVER WRITES. There is no UPDATE, INSERT or DELETE in this file and
// no --apply flag. Repairing affected rows is a money-path change that needs
// explicit sign-off; this only answers "how many, and for how much?".
//
// DENOMINATOR — read this before quoting any number it prints. The population is
// estimates reachable from a `Takeoff` row (`Takeoff.estimateId`), which is the
// only durable marker that an estimate came out of the takeoff pipeline. An
// estimate whose takeoff record was deleted is invisible here and is reported as
// a caveat, not silently dropped.
//
// TAX-ROW DETECTION uses three independent signals, reported separately so a miss
// in any one of them is visible rather than silent:
//   1. the takeoff's own `aiEstimateData` JSON, which stores the raw `costCode`
//      string the model produced. This is the closest thing to ground truth for
//      "did this takeoff carry a 99-TAX line".
//   2. the estimate item's resolved cost code `99-TAX` / `99-TAX-*`, via the same
//      `isTaxCostCode` helper the app uses, so this can never drift from the app.
//   3. the item NAME looking like a sales-tax line. `convert-to-estimate` resolves
//      `costCodeId` through the company's cost-code table, so if `99-TAX` was never
//      seeded as a cost code the row lands with costCodeId = null and signal 2
//      cannot see it at all.
//
// Usage (must run under tsx — imports the TypeScript helper directly so there is
// no second copy of the tax-row rule to drift):
//   npx tsx scripts/audit-takeoff-double-tax.mjs
//   npx tsx scripts/audit-takeoff-double-tax.mjs --limit 50
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL   Supabase transaction pooler URL (must include ?pgbouncer=true)
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import fs from "node:fs";
import * as takeoffCosting from "../src/lib/takeoff-costing.ts";

// tsx transpiles the .ts helper to CJS while this .mjs stays native ESM, so the
// named export can arrive under `.default` depending on interop. Same dance as
// scripts/audit-stale-margins.mjs.
const { isTaxCostCode } = takeoffCosting.isTaxCostCode ? takeoffCosting : takeoffCosting.default;

for (const f of [".env.local", ".env", ".env.production.local"]) {
  if (fs.existsSync(f)) dotenv.config({ path: f, override: false });
}
if (process.env.AUDIT_ENV_FILE && fs.existsSync(process.env.AUDIT_ENV_FILE)) {
  dotenv.config({ path: process.env.AUDIT_ENV_FILE, override: true });
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Point AUDIT_ENV_FILE at the env file, or export it.");
  process.exit(1);
}

const limitArg = process.argv.indexOf("--limit");
const SAMPLE_LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 25 : 25;

const num = (v) => (v == null ? 0 : Number(v));
const rmc = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${n.toFixed(2)}`;
// Mirrors the AI prompt's tax line naming ("WA Sales Tax (8.4%)") without
// sweeping in ordinary items that merely mention tax in prose.
const looksLikeTaxName = (name) => /\b(sales\s*tax|wa\s*tax|use\s*tax)\b/i.test(String(name ?? ""));

const prisma = new PrismaClient();

(async () => {
  const settings = await prisma.companySettings.findUnique({
    where: { id: "singleton" },
    select: { salesTaxes: true },
  });
  let defaultRate = 0;
  try {
    const taxes = settings?.salesTaxes ? JSON.parse(settings.salesTaxes) : [];
    const def = Array.isArray(taxes) ? taxes.find((t) => t.isDefault) || taxes[0] : null;
    defaultRate = typeof def?.rate === "number" ? def.rate : 0;
  } catch {
    defaultRate = 0;
  }

  const takeoffs = await prisma.takeoff.findMany({
    where: { estimateId: { not: null } },
    select: { id: true, name: true, estimateId: true, createdAt: true, aiEstimateData: true },
  });
  const orphanTakeoffs = await prisma.takeoff.count({ where: { estimateId: null } });

  console.log("=== Takeoff double-tax audit (READ ONLY) ===");
  console.log(`Company default sales tax rate: ${defaultRate}%`);
  console.log(`Takeoffs linked to an estimate: ${takeoffs.length}`);
  console.log(`Takeoffs with no linked estimate (out of scope): ${orphanTakeoffs}`);
  console.log("");

  if (takeoffs.length === 0) {
    console.log("No takeoff-converted estimates exist. Nothing to audit, nothing to repair.");
    console.log("Audit complete — no writes made (none possible).");
    return;
  }

  const estimates = await prisma.estimate.findMany({
    where: { id: { in: takeoffs.map((t) => t.estimateId) } },
    select: {
      id: true, code: true, title: true, status: true, approvedAt: true,
      totalAmount: true, balanceDue: true, taxRatePercent: true, taxExempt: true,
      items: { select: { id: true, name: true, total: true, parentId: true, costCode: { select: { code: true } } } },
      paymentSchedules: { select: { id: true, name: true, amount: true, status: true } },
      invoices: { select: { id: true, code: true, totalAmount: true } },
    },
  });

  const affected = [];
  const cleanRows = [];

  const takeoffByEstimate = new Map(takeoffs.map((t) => [t.estimateId, t]));

  for (const est of estimates) {
    // Signal 1 — the raw AI payload the estimate was built from.
    let aiTaxRows = 0;
    try {
      const ai = JSON.parse(takeoffByEstimate.get(est.id)?.aiEstimateData ?? "null");
      aiTaxRows = Array.isArray(ai?.items) ? ai.items.filter((i) => isTaxCostCode(i?.costCode)).length : 0;
    } catch {
      aiTaxRows = 0;
    }

    // Section headers roll up into their children, so only LEAVES carry money.
    // A row is a header iff some other row names it as parent.
    const parentIds = new Set(est.items.map((i) => i.parentId).filter(Boolean));
    const leaves = est.items.filter((i) => !parentIds.has(i.id));

    const byCode = leaves.filter((i) => isTaxCostCode(i.costCode?.code));
    const byName = leaves.filter((i) => !isTaxCostCode(i.costCode?.code) && looksLikeTaxName(i.name));
    const taxRows = [...byCode, ...byName];

    if (taxRows.length === 0) {
      cleanRows.push({
        code: est.code,
        reason: aiTaxRows > 0
          ? `AI payload had ${aiTaxRows} tax row(s) but the estimate has none — REVIEW BY HAND`
          : "no tax line item",
      });
      continue;
    }

    const taxAmount = rmc(taxRows.reduce((s, i) => s + num(i.total), 0));
    const preTax = rmc(leaves.filter((i) => !taxRows.includes(i)).reduce((s, i) => s + num(i.total), 0));
    const correctTotal = rmc(preTax + taxAmount);
    const stored = rmc(num(est.totalAmount));
    const rate = est.taxRatePercent == null ? null : Number(est.taxRatePercent);

    // What the client is actually shown / billed today.
    // rate == null  -> portal adds defaultRate on top of a subtotal that already
    //                  contains the tax row, and approval grosses the stored total
    //                  up by the same factor. Both land on the same number.
    // rate != null  -> the gross-up already ran (or an editor save set a rate);
    //                  the stored total is what it is.
    const exposedTotal = rate == null && !est.taxExempt && defaultRate > 0
      ? rmc(stored * (1 + defaultRate / 100))
      : stored;
    const overstatement = rmc(exposedTotal - correctTotal);

    const row = {
      code: est.code, title: est.title, status: est.status,
      approved: !!est.approvedAt,
      rate, taxExempt: est.taxExempt,
      preTax, taxAmount, correctTotal, stored, exposedTotal, overstatement,
      invoices: est.invoices.map((v) => `${v.code} ${money(rmc(num(v.totalAmount)))}`),
      pendingMilestones: est.paymentSchedules.filter((p) => p.status === "Pending").length,
      detectedBy: `${byCode.length > 0 ? (byName.length > 0 ? "code+name" : "cost code") : "name only"} (ai payload tax rows: ${aiTaxRows})`,
    };

    if (Math.abs(overstatement) >= 0.01) affected.push(row);
    else cleanRows.push({ code: est.code, reason: `tax line present but total already ties out (${money(stored)})` });
  }

  console.log(`Takeoff-converted estimates examined: ${estimates.length}`);
  console.log(`  with a tax line AND an overstated client-facing total: ${affected.length}`);
  console.log(`  clean: ${cleanRows.length}`);
  console.log("");

  if (affected.length === 0) {
    console.log("ZERO affected estimates. The defect is real in code but has no production footprint.");
    console.log("Do NOT ship a data repair.");
  } else {
    const totalImpact = rmc(affected.reduce((s, r) => s + r.overstatement, 0));
    const signed = affected.filter((r) => r.approved);
    const signedImpact = rmc(signed.reduce((s, r) => s + r.overstatement, 0));
    console.log(`TOTAL OVERSTATEMENT: ${money(totalImpact)} across ${affected.length} estimate(s)`);
    console.log(`  of which already approved/signed: ${signed.length} estimate(s), ${money(signedImpact)}`);
    console.log("");
    console.log(`Detail (up to ${SAMPLE_LIMIT}):`);
    for (const r of affected.slice(0, SAMPLE_LIMIT)) {
      console.log(`  ${r.code} — ${r.title}`);
      console.log(`      status=${r.status} approved=${r.approved} storedRate=${r.rate ?? "null"} exempt=${r.taxExempt} detectedBy=${r.detectedBy}`);
      console.log(`      pre-tax ${money(r.preTax)} + tax line ${money(r.taxAmount)} = correct ${money(r.correctTotal)}`);
      console.log(`      stored ${money(r.stored)} -> client-facing ${money(r.exposedTotal)}  OVERSTATED BY ${money(r.overstatement)}`);
      console.log(`      invoices: ${r.invoices.length ? r.invoices.join(", ") : "none"} | pending milestones: ${r.pendingMilestones}`);
    }
    if (affected.length > SAMPLE_LIMIT) console.log(`  ...and ${affected.length - SAMPLE_LIMIT} more.`);
  }

  console.log("");
  console.log("Caveat: estimates whose Takeoff row was deleted are not reachable and are not counted.");
  console.log("Audit complete — no writes made (none possible).");
})()
  .catch((e) => {
    console.error("Audit failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
