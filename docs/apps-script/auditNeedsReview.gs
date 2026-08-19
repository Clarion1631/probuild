/**
 * GOLDEN TOUCH — "_Needs Review" BACKLOG AUDIT  [read-only, one-off]
 * ==================================================================
 * Answers one question for every file sitting in "_Needs Review":
 *
 *     Did this receipt ever reach QuickBooks, and was anyone ever told about it?
 *
 * Why this is needed: "_Needs Review" starts with "_" and is SKIPPED by the folder scan
 * in runReceiptAutomation(). Before v3.5, several paths moved a file there BEFORE sending
 * their alert email. If that email failed (a blown daily MailApp quota is the realistic
 * cause), the receipt ended up in a folder the trigger never revisits, with nobody told —
 * neither booked nor surfaced. v3.5 closed the hole going forward. This script finds the
 * ones it already swallowed.
 *
 * READ-ONLY BY CONSTRUCTION. It never moves a file, never edits a description, and never
 * emails QuickBooks. The only write it can perform is one summary email to you, and only
 * if you call auditNeedsReviewAndEmail() instead of auditNeedsReview().
 *
 * HOW TO RUN
 *   1. Paste this as a NEW file in the same Apps Script project (it reuses that project's
 *      NEW_RECEIPTS_FOLDER_ID / NEEDS_REVIEW_NAME constants, so it must live alongside
 *      runReceiptAutomation.gs).
 *   2. Select auditNeedsReview in the function dropdown and press Run.
 *   3. Read the execution log. Or run auditNeedsReviewAndEmail() to also get it by email.
 *
 * HOW TO READ THE VERDICTS (v2, 2026-08-14 — "emailed" no longer counts as "booked")
 *   CONFIRMED       the API path created a QBO Purchase and recorded its id — it IS in
 *                   the books. Do not re-enter it. See REASON for why it is parked.
 *   QUEUE ONLY      the email fallback delivered the document to QBO's receipts INBOX.
 *                   That is NOT a booked transaction — it books only when a human
 *                   reviews it in the QBO Receipts queue. Check the queue, not the GL.
 *   AMBIGUOUS       a send was attempted but never confirmed (emailing set, emailed
 *                   not). It may or may not have arrived. Look it up before entering.
 *   PARKED          never sent, parked for an actionable reason (gave up, multi-doc,
 *                   unreadable total, bad format, possible duplicate). Needs a human.
 *   NON-PURCH       deliberately not a purchase for this pipeline: payroll/non-receipt,
 *                   or an Amazon document owned by the Amazon Business QBO app.
 *   UNKNOWN         no usable state on the file (dropped in by hand, or pre-dates state
 *                   tracking). Judge it from the document.
 *   Bank-feed match correctness (matched-to-the-right-line) is NOT this script's job —
 *   that lives in the ProBuild bank ledger / wrong-match detector.
 *
 * And the column that matters most for the bug being audited:
 *   ALERTED  yes — a human was told why this file is here.
 *            NO  — nobody was ever told. These are the silent losses. If such a file is
 *                 also NOT BOOKED, that expense is missing from QuickBooks and no email
 *                 about it was ever sent. Those are listed again under ACTION REQUIRED.
 */

/** Run this one. Logs the report. */
function auditNeedsReview() {
  const report = buildNeedsReviewAudit_();
  Logger.log(report);
  return report;
}

/** Same audit, but also emails the report to ALERT_EMAIL. */
function auditNeedsReviewAndEmail() {
  const report = buildNeedsReviewAudit_();
  Logger.log(report);
  if (MailApp.getRemainingDailyQuota() <= 0) {
    Logger.log("\n[NOT EMAILED] Daily mail quota is exhausted — the report above is complete; re-run tomorrow to receive it by email.");
    return report;
  }
  MailApp.sendEmail(ALERT_EMAIL, "Receipt bot: _Needs Review backlog audit", report);
  return report;
}

function buildNeedsReviewAudit_() {
  const root = DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID);
  const folders = root.getFoldersByName(NEEDS_REVIEW_NAME);
  if (!folders.hasNext()) return 'No "' + NEEDS_REVIEW_NAME + '" folder exists yet — nothing to audit.';

  const rows = [];
  const files = folders.next().getFiles();
  while (files.hasNext()) rows.push(auditOneFile_(files.next()));

  if (!rows.length) return '"' + NEEDS_REVIEW_NAME + '" is empty — nothing to audit.';

  // Oldest first: the silent losses are the old ones, and they are what you want to see.
  rows.sort(function (a, b) { return a.created < b.created ? -1 : (a.created > b.created ? 1 : 0); });

  const counts = { CONFIRMED: 0, "QUEUE ONLY": 0, AMBIGUOUS: 0, PARKED: 0, "NON-PURCH": 0, UNKNOWN: 0 };
  const silent = [];
  let money = 0;

  const lines = rows.map(function (r) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    if (!r.alerted && r.verdict !== "CONFIRMED" && r.verdict !== "NON-PURCH") {
      silent.push(r);
      const n = parseFloat(r.amount);
      if (!isNaN(n)) money += n;
    }
    return "  " + pad_(r.created, 10) + "  " + pad_(r.verdict, 11) + "  " +
           pad_(r.alerted ? "alerted" : "NO ALERT", 9) + "  " +
           pad_("$" + r.amount, 11) + "  " + pad_(r.reason, 26) + "  " + r.name;
  });

  let out = "";
  out += "_NEEDS REVIEW BACKLOG AUDIT — " + todayStr() + "\n";
  out += "=".repeat(82) + "\n";
  out += rows.length + " file(s) in \"" + NEEDS_REVIEW_NAME + "\".\n\n";
  out += "  " + pad_("UPLOADED", 10) + "  " + pad_("IN QBO?", 11) + "  " + pad_("TOLD?", 9) +
         "  " + pad_("AMOUNT", 11) + "  " + pad_("REASON", 26) + "  FILE\n";
  out += "  " + "-".repeat(80) + "\n";
  out += lines.join("\n") + "\n\n";

  out += "SUMMARY\n";
  out += "  API-confirmed QBO Purchase (leave alone):   " + (counts["CONFIRMED"] || 0) + "\n";
  out += "  Emailed to QBO inbox, NOT booked (queue):   " + (counts["QUEUE ONLY"] || 0) + "\n";
  out += "  Send attempted, unconfirmed (check QBO):    " + (counts["AMBIGUOUS"] || 0) + "\n";
  out += "  Parked, actionable (needs a human):         " + (counts["PARKED"] || 0) + "\n";
  out += "  Deliberately non-purchase (payroll/Amazon): " + (counts["NON-PURCH"] || 0) + "\n";
  out += "  No state on file (judge by eye):            " + (counts["UNKNOWN"] || 0) + "\n\n";

  if (silent.length) {
    out += "ACTION REQUIRED — " + silent.length + " file(s) reached this folder with NOBODY TOLD.\n";
    out += "These are the silent losses. Each is missing from QuickBooks (or unconfirmed) AND\n";
    out += "never generated an alert email, so nothing in your inbox points at them.\n";
    if (money > 0) out += "Approximate total at stake: $" + money.toFixed(2) + "\n";
    out += "\n";
    silent.forEach(function (r, i) {
      out += "  " + (i + 1) + ". " + r.name + "\n";
      out += "     uploaded " + r.created + " | " + r.verdict + " | vendor " + r.vendor +
             " | date " + r.docDate + " | $" + r.amount + "\n";
    });
    out += "\n";
  } else {
    out += "No silent losses found — every unbooked file here generated an alert.\n\n";
  }

  out += "Verdicts: CONFIRMED = API-created QBO Purchase (id on file), do not re-enter.\n";
  out += "QUEUE ONLY = delivered to QBO's receipts inbox but NOT booked — check the queue.\n";
  out += "AMBIGUOUS = send attempted, unconfirmed — look it up first. PARKED = never sent,\n";
  out += "needs a human. NON-PURCH = payroll/non-receipt or Amazon-app-owned. UNKNOWN = no state.\n";
  out += 'A "*" on the reason means it was inferred from the saved reading rather than\n';
  out += "recorded — those files were parked before v3.5 started writing down the reason.\n";
  return out;
}

function auditOneFile_(file) {
  const state = getState(file); // read-only helper from runReceiptAutomation.gs
  const d = state.data || {};
  const hasState = Object.keys(state).length > 0;

  // "emailed" alone proves DELIVERY, not BOOKING. Only an API-recorded purchase id
  // proves a GL transaction exists; the email fallback lands in QBO's review inbox.
  const apiConfirmed = !!(state.emailed && state.qboApi &&
                          !/^email-fallback:/.test(String(state.qboApi)));
  let verdict;
  if (apiConfirmed) verdict = "CONFIRMED";
  else if (state.emailed) verdict = "QUEUE ONLY";
  else if (state.emailing) verdict = "AMBIGUOUS";
  else if (state.amazonAppOwned || state.nonReceipt ||
           String((state.data || {}).doc_type || "").toLowerCase() === "non_receipt") verdict = "NON-PURCH";
  else if (hasState) verdict = "PARKED";
  else verdict = "UNKNOWN";

  // Was a human ever told? Any one of the alert flags counts. A file with no state at all
  // is reported as un-alerted, which is the safe reading — we cannot prove anyone was told.
  const alerted = !!(state.parkAlerted || state.nonReceiptAlerted || state.badFormatAlerted ||
                     state.weakDuplicateAlerted || state.refundAlerted);

  return {
    name: file.getName(),
    created: Utilities.formatDate(file.getDateCreated(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    verdict: verdict,
    alerted: alerted,
    reason: auditReason_(state),
    vendor: d.vendor || "?",
    docDate: normalizeDateStr(d.date) || d.date || "?",
    amount: d.total_amount ? cleanMoney(d.total_amount) : "?"
  };
}

// Why is this file parked? Most specific reason first.
//
// The inference block matters more than the explicit flags: a file parked BEFORE v3.5 has
// no parkReason at all (the old code moved it without recording why), and those pre-v3.5
// files are precisely the silent losses this audit exists to find. Reporting them as
// "unclear" would be the least useful possible answer, so where the flag is missing the
// reason is reconstructed from the extraction the AI already saved on the file.
function auditReason_(state) {
  // Explicit, recorded by v3.5+.
  if (state.parkReason === "zeroTotal") return "unreadable $0.00 total";
  if (state.parkReason === "multiDoc")  return "multiple receipts in one";
  if (state.parkReason === "gaveUp")    return "gave up (retry limit)";
  if (state.parkReason)                 return String(state.parkReason);
  if (state.nonReceipt) return "not a receipt (payroll?)";
  if (state.badFormat)  return "format QBO can't read";
  if (state.dedupWeak || state.duplicateOf) return "possible duplicate";
  if (state.refund)     return "refund / credit";

  // Inferred, for files parked before v3.5 recorded a reason.
  const d = state.data || {};
  const docType = String(d.doc_type || "").toLowerCase();
  if (docType === "multi")       return "multiple receipts in one*";
  if (docType === "non_receipt") return "not a receipt (payroll?)*";
  if (d.total_amount !== undefined && d.total_amount !== null &&
      cleanMoney(d.total_amount) === "0.00") return "unreadable $0.00 total*";

  if ((state.attempts || 0) >= 3 || (state.runs || 0) >= 6) return "gave up (retry limit)";
  if (Object.keys(state).length === 0) return "no state recorded";
  return "unclear — read the file";
}

function pad_(s, n) {
  s = String(s === undefined || s === null ? "" : s);
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}
