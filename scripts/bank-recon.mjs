/**
 * bank-recon.mjs — Washington Trust bank export vs processed Drive receipts.
 *
 * Finds bank debits with no matching receipt in the Drive automation archive
 * ("missing receipts") and receipts with no bank transaction (paid elsewhere).
 *
 * Usage:
 *   node scripts/bank-recon.mjs --bank <CSVEXP.csv> [--bank <more.csv>] --receipts <receipts.json>
 *        [--back 3] [--fwd 7] [--out report.md] [--json out.json]
 *
 * Inputs:
 *   --bank      WA Trust "CSV" export (Standard Grid columns: Post Date, ...,
 *               Debit/Credit, Amount, Customer Reference, Transaction Detail, Type)
 *   --receipts  JSON array of { name, url? } where name follows the automation
 *               convention: {Project}_{YYYY-MM-DD}_{Vendor}_{Ref}_${Amount}.{ext}
 *   --back/--fwd  date window in calendar days (receipt date vs bank post date)
 *
 * No credentials, no network — pure local comparison.
 */
import fs from "node:fs";
import path from "node:path";

// PowerShell 5.1 writes UTF-8 with a BOM; strip it or JSON.parse/header detection breaks.
const readText = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "");

// ---------- args ----------
const args = process.argv.slice(2);
const opt = { bank: [], receipts: null, pending: null, back: 3, fwd: 7, grace: 4, out: null, json: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--bank") opt.bank.push(args[++i]);
  else if (a === "--receipts") opt.receipts = args[++i];
  else if (a === "--pending") opt.pending = args[++i];
  else if (a === "--back") opt.back = Number(args[++i]);
  else if (a === "--fwd") opt.fwd = Number(args[++i]);
  else if (a === "--grace") opt.grace = Number(args[++i]);
  else if (a === "--out") opt.out = args[++i];
  else if (a === "--json") opt.json = args[++i];
  else { console.error(`Unknown arg: ${a}`); process.exit(1); }
}
if (!opt.bank.length || !opt.receipts) {
  console.error("Required: --bank <csv> --receipts <json>");
  process.exit(1);
}

// ---------- helpers ----------
function parseCsv(text) {
  // RFC-4180-ish: handles quoted fields with commas and "" escapes.
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCents(s) {
  const n = Number(String(s).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n) * 100);
}

function utcDate(y, mo, d) { // reject impossible dates (06/31 would silently roll over)
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

function parseUsDate(s) { // "06/11/2026"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? utcDate(+m[3], +m[1], +m[2]) : null;
}

function parseIsoDate(s) { // "2026-06-11"
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? utcDate(+m[1], +m[2], +m[3]) : null;
}

const DAY = 86_400_000;
const fmt = (d) => d.toISOString().slice(0, 10);
const money = (c) => `$${(c / 100).toFixed(2)}`;

function tokens(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3);
}
function vendorScore(receiptVendor, bankDetail) {
  const rt = tokens(receiptVendor), bt = new Set(tokens(bankDetail));
  if (!rt.length) return 0;
  let hits = 0;
  for (const t of rt) {
    if (bt.has(t)) { hits++; continue; }
    for (const b of bt) if (b.startsWith(t) || t.startsWith(b)) { hits += 0.5; break; }
  }
  return hits / rt.length;
}

// ---------- load bank ----------
// Debits that never have receipts: payroll, bank/processor fees, internal moves,
// loan/tax/credit-card-bill payments (those purchases reconcile on the card statement).
const IGNORE_RULES = [
  /GUSTO/i, /PAYROLL/i,
  /INTUIT/i, /QUICKBOOKS/i, /QBOOKS/i,
  /ANALYSIS FEE/i, /SERVICE CHARGE/i, /MAINTENANCE FEE/i, /WIRE FEE/i, /OVERDRAFT/i,
  /TRANSFER TO/i, /INTERNET TRANSFER/i, /PLAID/i, /TRANSFER\s+STRIPE/i,
  /SYF PAYMNT/i, /AUTOMATIC LOAN PAYMENT/i, /TAX PYMT/i, /BLS PYMT/i,
  /WITHDRAWAL DDA/i,
];
// Person-to-person payments (sub/helper payouts, reimbursements). Still matchable —
// some carry receipts (e.g. Cash App to a vendor) — but leftovers get their own
// section instead of "missing receipts". "PAYPAL *X" / merchant prefixes are NOT p2p.
const P2P_RULES = [/VENMO/i, /CASH APP\*/i, /ZELLE/i, /INST XFER\s+PAYPAL/i, /APPLE CASH/i];

const bankTxns = [];
for (const file of opt.bank) {
  const rows = parseCsv(readText(file));
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iDate = col("post date"), iDC = col("debit/credit"), iAmt = col("amount"),
    iDetail = col("transaction detail"), iDesc = col("transaction description"),
    iStatus = col("status"), iCustRef = col("customer reference"), iType = col("type");
  if (iDate < 0 || iAmt < 0) { console.error(`Unrecognized CSV header in ${file}`); process.exit(1); }
  for (const r of rows.slice(1)) {
    if (!r[iDate]) continue;
    const date = parseUsDate(r[iDate]);
    const cents = toCents(r[iAmt]);
    if (!date || cents === null) continue;
    const isDebit = iDC >= 0 ? /debit/i.test(r[iDC]) : Number(String(r[iAmt]).replace(/[$,]/g, "")) < 0;
    const detail = iDetail >= 0 ? r[iDetail] : "";
    const cardMatch = /C#\s?(\d{4})/.exec(detail);
    bankTxns.push({
      date, cents, isDebit,
      status: iStatus >= 0 ? r[iStatus] : "",
      desc: iDesc >= 0 ? r[iDesc] : "",
      detail,
      card: cardMatch ? cardMatch[1] : "",
      custRef: iCustRef >= 0 ? r[iCustRef] : "",
      type: iType >= 0 ? r[iType] : "",
      file: path.basename(file),
    });
  }
}

const debits = bankTxns.filter((t) => t.isDebit);
const credits = bankTxns.length - debits.length;
for (const t of debits) {
  const hay = `${t.desc} ${t.detail}`;
  // P2P first: "ZELLE PAYMENT TO X" must land in p2p, not be swallowed by /TRANSFER TO/.
  t.bucket = P2P_RULES.some((re) => re.test(hay)) ? "p2p"
    : IGNORE_RULES.some((re) => re.test(hay)) ? "ignored"
    : "matchable";
}

// ---------- load receipts ----------
const receiptFiles = JSON.parse(readText(opt.receipts));
const receipts = [];
const unparsed = [];
for (const f of receiptFiles) {
  const name = typeof f === "string" ? f : f.name;
  const url = typeof f === "string" ? "" : (f.url || f.display_url || "");
  const m = /^(.+?)_(\d{4}-\d{2}-\d{2})_(.+)_\$([\d,]+\.\d{2})\.[A-Za-z0-9]+$/.exec(name);
  if (!m) { unparsed.push(name); continue; }
  const [, project, dateStr, middle, amountStr] = m;
  const date = parseIsoDate(dateStr);
  const cents = toCents(amountStr);
  if (!date || cents === null) { unparsed.push(name); continue; } // impossible date like 2026-06-31
  let vendor = middle, ref = "";
  const parts = middle.split("_");
  const last = parts[parts.length - 1];
  // Bare years ("Studio_2024") are vendor name, not an invoice ref — a year string
  // would otherwise earn a bogus refHit bonus against dates in bank detail text.
  const looksLikeYear = /^(19|20)\d{2}$/.test(last);
  if (parts.length > 1 && !looksLikeYear && /^[A-Za-z0-9.-]+$/.test(last) && (/\d/.test(last) || /^noinv$/i.test(last))) {
    ref = last;
    vendor = parts.slice(0, -1).join("_");
  }
  receipts.push({
    name, url, date, cents, ref,
    project: project.replace(/_/g, " "),
    vendor: vendor.replace(/_/g, " ").replace(/\s+/g, " ").trim(),
  });
}

// ---------- load triage queue (_Needs Review) ----------
// Receipts uploaded but not yet filed/renamed by the bookkeeper. They live in the
// Drive "_Needs Review" intake folder under raw names. Some carry an amount in the
// filename ("OWNER DRAW - Lowes $261.05 ...", or an OCR-supplied {amount}); raw
// camera/scan dumps ("Scanned_*.pdf", "PXL_*.jpg", "Bank Check.pdf") do not. A bank
// debit whose amount matches a pending item is NOT missing — it's awaiting filing,
// so it must not be nudged. Pass via --pending <json> ([{name,url,amount?}]).
const pending = [];
const pendingRaw = []; // uploads with no extractable amount — can't auto-match, surfaced as a caveat
if (opt.pending) {
  for (const f of JSON.parse(readText(opt.pending))) {
    const name = typeof f === "string" ? f : f.name;
    const url = typeof f === "string" ? "" : (f.url || f.display_url || "");
    // Prefer an OCR-supplied amount; else pull the first $-amount out of the filename.
    let cents = (f && f.amount != null) ? toCents(f.amount) : null;
    if (cents === null) {
      const m = /\$([\d,]+(?:\.\d{2})?)/.exec(name);
      if (m) cents = toCents(m[1]);
    }
    if (cents === null) pendingRaw.push({ name, url });
    else pending.push({ name, url, cents });
  }
}

// ---------- match ----------
// Hard filter: same cents, post date within [-back, +fwd] of receipt date.
// Rank candidate pairs: ref seen in bank text >> vendor tokens >> date proximity.
// P2P debits participate too (a Cash App payment to a vendor can carry a receipt);
// only the leftovers split into "missing receipts" vs "p2p" sections.
const matchable = debits.filter((t) => t.bucket !== "ignored");
const pairs = [];
for (let ri = 0; ri < receipts.length; ri++) {
  const r = receipts[ri];
  for (let bi = 0; bi < matchable.length; bi++) {
    const b = matchable[bi];
    if (b.cents !== r.cents) continue;
    const diffDays = Math.round((b.date - r.date) / DAY);
    if (diffDays < -opt.back || diffDays > opt.fwd) continue;
    const bankText = `${b.detail} ${b.custRef}`;
    const refHit = r.ref && !/^noinv$/i.test(r.ref) && bankText.toUpperCase().includes(r.ref.toUpperCase()) ? 1 : 0;
    const vScore = vendorScore(r.vendor, bankText);
    pairs.push({ ri, bi, score: refHit * 10 + vScore * 5 - Math.abs(diffDays) * 0.1, diffDays });
  }
}
// Maximum-cardinality one-to-one assignment (Kuhn's augmenting paths) so a
// high-scoring pair can't orphan an otherwise-valid match in same-amount
// clusters. Adjacency is score-ordered (ties broken by bank index) so better
// pairings are still preferred whenever cardinality allows.
const adj = new Map();
for (const p of pairs) {
  if (!adj.has(p.ri)) adj.set(p.ri, []);
  adj.get(p.ri).push(p);
}
for (const list of adj.values()) list.sort((a, b) => b.score - a.score || a.bi - b.bi);
const bOwner = new Map(); // bi -> ri
const rPair = new Map();  // ri -> pair
function tryAssign(ri, visited) {
  for (const p of adj.get(ri) || []) {
    if (visited.has(p.bi)) continue;
    visited.add(p.bi);
    if (!bOwner.has(p.bi) || tryAssign(bOwner.get(p.bi), visited)) {
      bOwner.set(p.bi, ri);
      rPair.set(ri, p);
      return true;
    }
  }
  return false;
}
const receiptOrder = [...adj.keys()].sort((a, b) => adj.get(b)[0].score - adj.get(a)[0].score || a - b);
for (const ri of receiptOrder) tryAssign(ri, new Set());
const matches = [...rPair.values()].sort((a, b) => a.ri - b.ri);
const usedR = new Set(rPair.keys()), usedB = new Set(bOwner.keys());

const newest = new Date(Math.max(...bankTxns.map((t) => +t.date)));
const graceCutoff = +newest - opt.grace * DAY;
const leftovers = matchable.filter((_, bi) => !usedB.has(bi));

// Pull any leftover whose amount matches an uploaded-but-unfiled item out of the
// missing/recent buckets — it's in the triage queue, not actually missing. One
// pending item clears one bank debit (consume so two equal debits aren't both cleared).
const pendingLeft = pending.map((p) => ({ ...p }));
const inTriage = [];
for (const t of leftovers.filter((t) => t.bucket === "matchable")) {
  const hit = pendingLeft.find((p) => p.cents === t.cents && !p.used);
  if (hit) { hit.used = true; t.triage = hit; inTriage.push(t); }
}
const triageSet = new Set(inTriage);
const missingReceipts = leftovers.filter((t) => t.bucket === "matchable" && +t.date < graceCutoff && !triageSet.has(t));
const recentMissing = leftovers.filter((t) => t.bucket === "matchable" && +t.date >= graceCutoff && !triageSet.has(t));
const p2p = leftovers.filter((t) => t.bucket === "p2p");
const unmatchedReceipts = receipts.filter((_, ri) => !usedR.has(ri));
const ignored = debits.filter((t) => t.bucket === "ignored");

// Reimbursement hint: an unmatched receipt whose exact amount shows up as a P2P
// debit within 14 days usually means someone bought on a personal card and got
// paid back (e.g. Venmo). Annotate rather than match.
for (const r of unmatchedReceipts) {
  const hint = p2p.find((t) => t.cents === r.cents && Math.abs(t.date - r.date) <= 14 * DAY);
  if (hint) r.hint = `amount matches ${fmt(hint.date)} ${hint.detail.trim().slice(0, 60)}`;
}

// ---------- report ----------
const lines = [];
const today = fmt(newest);
const row = (t) => `| ${fmt(t.date)} | ${money(t.cents)} | ${t.card || "—"} | ${t.status} | ${t.detail.replace(/\|/g, "/")} |`;
lines.push(`# Bank ↔ Receipt Reconciliation — through ${today}`);
lines.push("");
lines.push(`Bank rows: ${bankTxns.length} (${debits.length} debits, ${credits} credits) · Receipts: ${receipts.length} · Matched: ${matches.length}`);
lines.push("");

lines.push(`## ❌ Missing receipts (${missingReceipts.length}) — bank debits older than ${opt.grace} days, not in Drive and not in the triage queue`);
lines.push("");
if (pendingRaw.length) {
  lines.push(`> ⚠️ ${pendingRaw.length} upload(s) sit in _Needs Review with no amount in the filename, so they can't be auto-matched — they may cover some rows below. OCR them (or have the bookkeeper file them) before nudging: ${pendingRaw.map((p) => p.name).join("; ")}`);
  lines.push("");
}
lines.push("| Post date | Amount | Card | Status | Bank detail |");
lines.push("|---|---|---|---|---|");
for (const t of [...missingReceipts].sort((a, b) => b.date - a.date)) lines.push(row(t));
lines.push("");

if (recentMissing.length) {
  lines.push(`## ⏳ Recent, no receipt yet (${recentMissing.length}) — inside the ${opt.grace}-day grace period, no nudge`);
  lines.push("");
  lines.push("| Post date | Amount | Card | Status | Bank detail |");
  lines.push("|---|---|---|---|---|");
  for (const t of [...recentMissing].sort((a, b) => b.date - a.date)) lines.push(row(t));
  lines.push("");
}

if (inTriage.length) {
  lines.push(`## 🗂 In triage queue (${inTriage.length}) — uploaded, awaiting filing in _Needs Review (not missing, do not nudge)`);
  lines.push("");
  lines.push("| Post date | Amount | Card | Bank detail | Matched upload |");
  lines.push("|---|---|---|---|---|");
  for (const t of [...inTriage].sort((a, b) => b.date - a.date)) {
    lines.push(`| ${fmt(t.date)} | ${money(t.cents)} | ${t.card || "—"} | ${t.detail.replace(/\|/g, "/").slice(0, 60)} | ${t.triage.name} |`);
  }
  lines.push("");
}

lines.push(`## 👤 Person-to-person payments (${p2p.length}) — Venmo/CashApp/Zelle/PayPal transfers, no receipt matched`);
lines.push("");
lines.push("| Post date | Amount | Card | Status | Bank detail |");
lines.push("|---|---|---|---|---|");
for (const t of [...p2p].sort((a, b) => b.date - a.date)) lines.push(row(t));
lines.push("");

lines.push(`## 🧾 Receipts with no bank match (${unmatchedReceipts.length}) — paid on another account/card, check not cleared, or outside export window`);
lines.push("");
lines.push("| Receipt date | Amount | Project | Vendor | File | Note |");
lines.push("|---|---|---|---|---|---|");
for (const r of [...unmatchedReceipts].sort((a, b) => b.date - a.date)) {
  lines.push(`| ${fmt(r.date)} | ${money(r.cents)} | ${r.project} | ${r.vendor} | ${r.name} | ${r.hint || ""} |`);
}
lines.push("");

lines.push(`## ✅ Matched (${matches.length})`);
lines.push("");
lines.push("| Receipt | Bank post date | Amount | Δdays | Bank detail |");
lines.push("|---|---|---|---|---|");
for (const p of matches) {
  const r = receipts[p.ri], b = matchable[p.bi];
  lines.push(`| ${r.name} | ${fmt(b.date)} | ${money(b.cents)} | ${p.diffDays} | ${b.detail.replace(/\|/g, "/").slice(0, 80)} |`);
}
lines.push("");
lines.push(`Ignored ${ignored.length} debits (payroll/fees/transfers/loan/tax/card-bill payments).`);
if (unparsed.length) {
  lines.push("");
  lines.push(`⚠️ ${unparsed.length} receipt filename(s) did not parse: ${unparsed.join(", ")}`);
}

const report = lines.join("\n");
console.log(report);
if (opt.out) fs.writeFileSync(opt.out, report);
if (opt.json) {
  const txJson = (t) => ({ date: fmt(t.date), amount: money(t.cents), card: t.card, status: t.status, detail: t.detail });
  fs.writeFileSync(opt.json, JSON.stringify({
    generated: today,
    missingReceipts: missingReceipts.map(txJson),
    recentMissing: recentMissing.map(txJson),
    inTriage: inTriage.map((t) => ({ ...txJson(t), matchedUpload: t.triage.name })),
    pendingUnidentified: pendingRaw.map((p) => p.name),
    p2p: p2p.map(txJson),
    unmatchedReceipts: unmatchedReceipts.map((r) => ({ date: fmt(r.date), amount: money(r.cents), project: r.project, vendor: r.vendor, file: r.name, url: r.url, hint: r.hint || "" })),
    matched: matches.length,
    ignored: ignored.length,
  }, null, 2));
}
