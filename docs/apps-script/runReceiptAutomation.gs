/**
 * GOLDEN TOUCH — RECEIPT + CHECK → QUICKBOOKS  [lean v3.4]
 * =====================================================
 * Scans the "New Receipts & Checks" folder every 10 minutes (existing trigger on
 * runReceiptAutomation — do NOT rename that function) and, for each receipt or
 * handwritten check, reads just three things and forwards it to QuickBooks:
 *
 *     VENDOR (payee for checks)  •  DATE  •  AMOUNT
 *
 * Marge then categorizes it to the right project INSIDE QuickBooks. Pulling those
 * QBO transactions into ProBuild is a SEPARATE process — not this script.
 *
 * Routing: the file's folder IS its project. Whatever project folder Richard (or
 * anyone) drops the file into, that folder name is carried onto the renamed file
 * AND into the QuickBooks email subject/body, so Marge always sees the job.
 *   - Project folders -> project name carried through.
 *   - "Shop" folder   -> overhead; the nested category subfolder name rides along as a hint.
 *
 * Per file: 1) AI reads vendor / date / amount (+ check #, memo for checks)
 *           2) renames to <Project>_<Date>_<Vendor>_<Inv|Check#>_$<Total>
 *           3) collapses duplicate copies of the same purchase (content dedup)
 *           4) emails the document to the QBO receipt inbox
 *           5) archives it to Processed Receipts/<Year>/<Month>
 *
 * Date rule: use the date READ off the document; if it can't be read, fall back to
 * the date the file was UPLOADED to Drive (file.getDateCreated()).
 *
 * Crash/retry safe: per-file progress lives in the Drive "description" as JSON
 * { runs, attempts, data, dedupOwned, dedupPk, dedupWeakOwned, dedupWeakPk, dedupWeak,
 *   dedupWeakReason, emailing, emailed, refund, refundAlerted, nonReceipt,
 *   nonReceiptAlerted, badFormat, badFormatAlerted, duplicateOf, weakDuplicateAlerted,
 *   parkReason, parkAlerted, amazonAppOwned }.
 *
 * PARKED (not wired into this flow):
 *   - WA "tax paid at source" recovery math -> taxPaidAtSource.parked.gs
 *   - ProBuild push                         -> sendToProBuild.gs (future QBO->ProBuild puller replaces it)
 *
 * v3.1: a file containing SEVERAL receipts/checks scanned together now gets parked
 * in "_Needs Review" with a "split me" email instead of silently booking just one
 * page; a blank/invalid Gemini response falls through to the backup model instead
 * of burning one of the file's 3 attempts.
 * v3.2: multi-receipt PDFs are AUTO-SPLIT — the AI maps pages to transactions,
 * pdf-lib writes one child PDF per transaction back into the SAME folder (each
 * then processes through the normal pipeline), and the original is archived to
 * "_Split Originals" with a report email. Anything that can't be verified (not a
 * PDF, too many pages, AI page map overlapping/incomplete, library/network
 * failure) falls back to the v3.1 park + "split me" email. Nothing is deleted.
 * v3.3: refunds carry credit warnings plus a retry-safe bookkeeper alert; NoInv
 * documents use a weak date/amount dedup review path; non-receipts park immediately.
 * Trigger runs are serialized, and required review alerts now succeed before parking.
 * v3.4: ATTACHMENT FORMAT is now enforced. QuickBooks' receipt inbox renders only
 * PDF/JPG/PNG, and it fails silently on everything else — a .txt is accepted but never
 * displays as a receipt, while HEIC/WEBP are bounced so the expense never books at all.
 * A stray .txt is rendered to PDF at send time; anything Apps Script cannot decode parks
 * in "_Needs Review" with the vendor/date/amount in the alert so it can be booked by hand.
 * v3.5: PARKING IS NOW DURABLE. Every terminal park goes through parkWithAlert_(), which
 * persists WHY the file is being parked, then alerts, then moves — in that order. Before
 * this, three paths ($0.00 unreadable total, un-splittable multi-doc, generic give-up)
 * moved the file into "_Needs Review" and only then tried to email. "_Needs Review" is
 * skipped by the folder scan, so a failed alert (mail quota is the realistic cause — this
 * bot sends several alerts per run) left the receipt neither in QuickBooks nor in front of
 * a human. Parked files are now retried alert-and-move only, never re-sent to QBO.
 * Also: the QBO send checks the remaining mail quota BEFORE it marks "emailing", so a
 * quota outage no longer leaves a dedup claim held against a purchase that never booked.
 * (A send that THREW still holds its claim — MailApp gives no dispatch receipt, so a
 * thrown call is not evidence of non-delivery, and releasing on that guess double-books.)
 * The whole scan also no-ops when the daily mail quota is gone, so an outage can't burn
 * every file's retry counter and dump readable receipts into manual entry.
 * NOT fixed here, and still open: tryAutoSplitMultiDoc's two alerts. Both must move the
 * original BEFORE emailing to keep the split one-shot (a replay would regroup the pages
 * and write a SECOND set of child PDFs, double-booking), so a failed report/alert there
 * still goes unheard. Fixing it needs the split made atomic — see the notes in that
 * function. It is the one remaining path in this class.
 * v3.6: DEDUP NO LONGER SPLITS ON A MISREAD NAME. The AI reads the same purchase's vendor
 * AND invoice number differently across a vendor's own email formats (one Lowe's in-store
 * sale mails twice: "Lowe's Home Improvement" + order # 2016322…, then "Lowe's" + invoice
 * # 95870), and every such drift used to put ONE purchase on TWO keys, so neither copy was
 * quarantined and BOTH were forwarded — double-booking the expense. Three changes: the
 * authoritative key drops the vendor (date + invoice/check # is already a unique purchase),
 * that key now demands a ref that LOOKS like a real number (refLooksReal_) because without
 * the vendor an OCR placeholder such as "N/A" would collide unrelated receipts, and the weak
 * vendor/date/amount net runs for EVERY document instead of only ref-less ones, so a
 * purchase whose REF drifted is still caught. Weak hits always go to human review — two
 * genuine same-day same-amount buys from one vendor do happen — and a claim now records its
 * total, so an authoritative collision whose totals DISAGREE is reviewed rather than
 * collapsed on a guess. See makeDedupKey / makeWeakDedupKey / canonicalVendor.
 */

/**
 * --- CONFIGURATION ---
 */
const NEW_RECEIPTS_FOLDER_ID = "1jFqGFcf6zaONVrIjFhgsm6WnDephQgA6"; // "New Receipts & Checks"
const PROCESSED_RECEIPTS_ID  = "1j5XQx4EZ6LT-T7Tzvvrp_Y5ksiu0Kzv2"; // Archive Root
const QBO_EMAIL_ADDRESS      = "golden_touch_remodeling_llc+expenses@assist.intuit.com";
const ALERT_EMAIL            = Session.getEffectiveUser().getEmail();

// The ONLY formats the QuickBooks receipt inbox can render (straight from Intuit's own
// bounce notice: "re-save and send the files in a supported format: PDF / JPG / PNG").
// Everything else fails in one of two silent ways: a .txt is ACCEPTED but never shown as
// a receipt document, and HEIC/WEBP are hard-bounced with "Quickbooks can't view attached
// files" — so the expense simply never books. Nothing outside this list may be emailed.
const QBO_OK_MIMES = ["application/pdf", "image/jpeg", "image/png"];

// The Gemini key comes from geminiApiKey_() in Config.gs, which reads Script Properties.
// Models are tried IN ORDER — if one is overloaded (HTTP 503) or rate-limited (429),
// the read falls through to the next, so one busy model never sinks the run.
// Chain verified live 2026-08-19 against a real receipt. The previous chain
// ["gemini-2.5-pro","gemini-2.5-flash"] died ENTIRELY on 08-10: 2.5-pro was
// RETIRED (404) while the project was simultaneously blocked (403), so nine
// days of receipts failed with no survivor. Leading with a "-latest" alias
// means Google repoints it as models retire, so one retirement can no longer
// take the pipeline down. WARNING: the /models LISTING endpoint LIES - it
// returned both dead models throughout the outage while generateContent 404d
// and 403d them. Health checks must call generateContent for real.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-pro-latest"];
const MAX_AI_ATTEMPTS = 3;  // failed AI reads per file, across runs
const MAX_TOTAL_RUNS  = 6;  // total processing passes per file, across runs
// A pass that ended because GEMINI ITSELF was unavailable (503/429/404/403/network) says
// NOTHING about the document, so it must not spend a give-up strike — that is exactly how
// readable receipts were parked as "gave up" during a busy spell. Those passes are counted
// here instead and excluded from BOTH limits above. Fixing only MAX_AI_ATTEMPTS would not
// have helped: state.runs is incremented every pass, so the same file would simply park a
// few passes later. This still needs a ceiling — without one a revoked key or a long
// outage would retry forever, burning quota every trigger with nobody told. At the cap the
// file parks under PARK_AI_UNAVAILABLE, so the reason a human reads is the true one.
const MAX_BUSY_PASSES = 20;
// Returned by analyzeDriveFileWithGemini when every model failed for availability reasons.
// Identity-compared by the caller, so it can never be mistaken for a real extraction.
const AI_UNAVAILABLE = Object.freeze({ serviceUnavailable: true });
const NEEDS_REVIEW_NAME = "_Needs Review";
const DUPLICATES_NAME   = "_Duplicates";
// Terminal park reasons. Written to state.parkReason BEFORE the matching alert is sent,
// so once a file is ruled un-bookable no later pass can forward it to QuickBooks — the
// only work left for it is "get the alert out, then move it". See parkWithAlert_.
const PARK_ZERO_TOTAL = "zeroTotal";
const PARK_MULTI_DOC  = "multiDoc";
const PARK_GAVE_UP    = "gaveUp";
const PARK_AI_UNAVAILABLE = "aiUnavailable"; // Gemini never got to read it (see MAX_BUSY_PASSES)
const SPLIT_ORIGINALS_NAME = "_Split Originals"; // archive bin for auto-split source scans
const MAX_SPLIT_PAGES = 12;   // auto-split refuses PDFs longer than this
// Pinned pdf-lib build (no floating "latest") — Apps Script has no native PDF tool.
const PDF_LIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";

// Apps Script ScriptLock is not reentrant. The trigger owns one lock for the whole
// scan; helpers consult this flag so they do not deadlock by reacquiring that lock.
var RECEIPT_RUN_LOCK_HELD_ = false;

// Overhead filing folders inside "Shop" — (re)created if missing so there's always
// somewhere to drop an overhead receipt. Names MIRROR the Golden Touch QBO expense
// accounts (the "NN " prefix is only for Drive sort order — displayCategory() strips
// it before the QBO hint, so "07 Small tools & equipment" -> "Small tools & equipment").
// The scan walks WHATEVER folders exist, so you can still rename / nest in Drive.
const SHOP_CATEGORIES = [
  "01 Advertising & marketing",
  "02 Dues and Subscriptions",
  "03 Insurance",
  "04 Legal & accounting services",
  "05 Meals",
  "06 Office expenses",
  "07 Small tools & equipment",
  "08 Rent",
  "09 Equipment rental",
  "10 Repairs & maintenance",
  "11 Supplies",
  "12 Taxes paid",
  "13 Utilities",
  "14 Disposal & waste fees",
  "15 Vehicle expenses"
];

// Only the exact "Shop" folder is overhead. Names such as "Shop Shed" are projects.
function isOverheadShopFolder_(name) {
  return String(name || "").trim().toLowerCase() === "shop";
}

/**
 * MAIN — trigger target (keep this name; the 10-min trigger is bound to it).
 */
function runReceiptAutomation() {
  // (The 2026-07-31 go-live bootstraps that seeded QBO_API_PUSH_ENABLED and
  // RECEIPT_INGEST_SECRET into Script Properties were removed once both were
  // verified live — the API-path booking of Purchase 6364 proves it.)

  const runLock = LockService.getScriptLock();
  if (!runLock.tryLock(1000)) {
    Logger.log(" > [SKIP] Another receipt automation run is already active.");
    return;
  }
  RECEIPT_RUN_LOCK_HELD_ = true;
  try {
    // Nothing this scan does is useful without mail: every path either forwards a document
    // to QuickBooks or has to tell a human why it didn't. With no quota left, processing
    // would only burn each file's retry counters — six passes of that is about an hour, and
    // it would push perfectly readable receipts into terminal give-up (manual entry for
    // Marge) over an outage that heals itself at midnight. Skipping the scan costs nothing:
    // the files keep, and the next run after the reset picks them up untouched.
    if (MailApp.getRemainingDailyQuota() <= 0) {
      Logger.log(" > [SKIP] Daily mail quota is exhausted — pausing the scan until it resets.");
      return;
    }

    const rootFolder  = DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID);
    const archive     = DriveApp.getFolderById(PROCESSED_RECEIPTS_ID);
    const needsReview = getOrCreateFolder(rootFolder, NEEDS_REVIEW_NAME);

    Logger.log("--- RECEIPT + CHECK SCAN (Models: " + GEMINI_MODELS.join(", ") + ") ---");

    const projectFolders = rootFolder.getFolders();
    while (projectFolders.hasNext()) {
      const projectFolder = projectFolders.next();
      const projectName = projectFolder.getName();
      if (projectName.startsWith("_")) continue; // skip _Needs Review etc.

      if (isOverheadShopFolder_(projectName)) {
        // SHOP overhead: make sure the filing folders exist, then process everything
        // dropped anywhere in the Shop tree (deepest folder name rides along as a hint).
        ensureShopCategories(projectFolder);
        processFilesInIterator(projectFolder.getFiles(),
          { projectName: projectName, category: null, isShop: true }, archive, needsReview);
        processShopSubtree(projectFolder, projectName, archive, needsReview);
      } else {
        // PROJECT: files live in the project root.
        processFilesInIterator(projectFolder.getFiles(),
          { projectName: projectName, category: null, isShop: false }, archive, needsReview);
      }
    }

    // Daily intake-folder reconciliation (reconcileIntakeFolders.gs) — runs
    // LAST, inside the lock: receipt processing always gets the execution
    // budget first, and single-instance execution kills the duplicate-folder
    // race. Isolated so a reconciler failure never marks the scan failed.
    try { reconcileIntakeFoldersDaily_(); } catch (e) { Logger.log(" > [RECONCILE] error: " + e); }
  } finally {
    RECEIPT_RUN_LOCK_HELD_ = false;
    runLock.releaseLock();
  }
}

// Process EVERY sub-folder under Shop, at any depth, so nothing strands in a nested
// category. The folder a file sits in is its category hint. "_*" helpers skipped.
function processShopSubtree(folder, projectName, archive, needsReview) {
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    const catName = sub.getName();
    if (catName.startsWith("_")) continue;
    processFilesInIterator(sub.getFiles(),
      { projectName: projectName, category: catName, isShop: true }, archive, needsReview);
    processShopSubtree(sub, projectName, archive, needsReview);
  }
}

function processFilesInIterator(fileIterator, ctx, archive, needsReview) {
  while (fileIterator.hasNext()) {
    processSingleFile(fileIterator.next(), ctx, archive, needsReview);
  }
}

/**
 * CORE LOGIC
 */
function processSingleFile(file, ctx, archive, needsReview) {
  const originalName = file.getName();
  Logger.log("Processing: " + originalName + " [" + ctx.projectName + (ctx.category ? " / " + ctx.category : "") + "]");

  let state = getState(file);

  try {
    // -1. ALREADY RULED UN-BOOKABLE — a previous pass persisted a terminal park reason but
    // did not finish alerting/moving (a failed MailApp call is the realistic cause). The
    // reason is durable, so the ONLY work left is to finish the park; this file may never
    // be read again, priced again, or sent to QuickBooks. This runs BEFORE the give-up
    // counters on purpose: a mail-quota outage can then retry for as long as it takes
    // instead of being re-labelled as a generic give-up, which would both bury the
    // specific reason Marge needs and re-run the terminal branch's side effects.
    if (state.parkReason) {
      try {
        const parkMsg = parkAlertMessage_(state.parkReason, file, state, ctx, originalName);
        parkWithAlert_(file, state, state.parkReason, parkMsg.subject, parkMsg.body, needsReview);
        Logger.log(" > [PARKED: " + state.parkReason + "] alert + move completed; now in " + NEEDS_REVIEW_NAME + ".");
      } catch (parkErr) {
        Logger.log(" > [RETRY LATER] park (" + state.parkReason + ") alert/move failed: " + parkErr);
      }
      return;
    }

    // 0. Give up after too many tries (AI failures OR any other repeated error).
    const verdict = shouldGiveUp_(state);
    if (verdict.giveUp) {
      // Classified review items still need their distinct required alert if a prior
      // pass hit its terminal count while MailApp was failing. Handle them before
      // generic give-up so they never lose the alert or release another file's claim.
      if (state.nonReceipt) {
        try {
          sendNonReceiptAlertIfNeeded(file, state, ctx, originalName);
          file.moveTo(needsReview);
          Logger.log(" > [NON-RECEIPT] terminal retry parked in " + NEEDS_REVIEW_NAME + ".");
        } catch (nonReceiptErr) {
          Logger.log(" > [RETRY LATER] terminal non-receipt alert/park failed: " + nonReceiptErr);
        }
        return;
      }
      if (state.badFormat) {
        try {
          sendBadFormatAlertIfNeeded(file, state, ctx, originalName, normalizeMime_(file.getMimeType()));
          file.moveTo(needsReview);
          Logger.log(" > [UNSUPPORTED FOR QBO] terminal retry parked in " + NEEDS_REVIEW_NAME + ".");
        } catch (badFormatErr) {
          Logger.log(" > [RETRY LATER] terminal bad-format alert/park failed: " + badFormatErr);
        }
        return;
      }
      // dedupWeak is only ever set on a LOSING collision, so duplicateOf alone identifies a
      // review item. It is no longer paired with "!dedupOwned": a file can take the
      // authoritative claim and still lose the weak net (v3.6), and that file needs this
      // specific alert rather than the generic give-up one. Because it CAN now arrive here
      // holding a claim — a crash between the weak-hit setState and its release is enough —
      // the release is repeated here. It is idempotent, and skipping it would leave an
      // unbookable file owning a key that silently quarantines the next genuine copy.
      if (state.dedupWeak && state.duplicateOf) {
        try {
          sendWeakDuplicateAlertIfNeeded(file, state, originalName);
          if (!state.emailing) releaseDedupClaims_(state, file.getId());
          file.moveTo(needsReview);
          Logger.log(" > [POSSIBLE DUPLICATE] terminal retry parked in " + NEEDS_REVIEW_NAME + ".");
        } catch (weakDuplicateErr) {
          Logger.log(" > [RETRY LATER] terminal weak-duplicate alert/park failed: " + weakDuplicateErr);
        }
        return;
      }
      // An already-booked refund still needs its credit alert even if this file has
      // reached a terminal limit. Alert failure must leave it in intake for retry,
      // before any claim release or move makes the file unreachable to the trigger.
      if (state.emailed && state.refund && !state.refundAlerted) {
        const terminalData = state.data || {};
        const terminalTotal = cleanMoney(terminalData.total_amount);
        const terminalAiDate = normalizeDateStr(terminalData.date);
        const terminalDate = isValidDate(terminalAiDate) ? terminalAiDate : driveDateStr(file);
        try {
          sendRefundAlertIfNeeded(file, state, ctx, terminalData, terminalTotal, terminalDate);
          state = getState(file);
        } catch (refundAlertErr) {
          Logger.log(" > [RETRY LATER] terminal refund alert failed: " + refundAlertErr);
          return;
        }
      }
      // Release an UNBOOKED dedup claim so a future true copy can still book this
      // purchase. Guard on "!emailing" (not "!emailed"): once a QBO send was even
      // ATTEMPTED, QBO may hold the copy, so we must NOT release. This deliberately does
      // NOT try to exempt "the send threw" — a thrown MailApp call is not evidence that
      // nothing was dispatched. The mail-quota case that used to strand a claim here is
      // now caught BEFORE "emailing" is written (step 5), so a quota outage simply never
      // sets the flag and lands in this release on its own.
      if (!state.emailing) releaseDedupClaims_(state, file.getId());
      const giveUpReason = verdict.reason;
      const giveUpMsg = parkAlertMessage_(giveUpReason, file, state, ctx, originalName);
      parkWithAlert_(file, state, giveUpReason, giveUpMsg.subject, giveUpMsg.body, needsReview);
      Logger.log(" > [" + (giveUpReason === PARK_AI_UNAVAILABLE ? "AI UNAVAILABLE" : "GAVE UP") +
                 "] Moved to " + NEEDS_REVIEW_NAME);
      return;
    }
    state.runs = (state.runs || 0) + 1;
    setState(file, state);

    // 0.5 UNSUPPORTED FORMAT — checked BEFORE the AI, because no reading of the document
    // can make QuickBooks able to display it: the inbox renders only PDF/JPG/PNG. Gating
    // here also stops an unreadable HEIC from burning all 3 Gemini attempts and then
    // parking with the vague generic "needs help" alert instead of a specific one.
    // text/plain passes: sendToQBO renders it to PDF. HEIC/WEBP/GIF/TIFF/BMP cannot be
    // decoded by Apps Script at all, so the only honest option is a human re-save.
    // Flag FIRST, then alert, then move — the alert must succeed before the file leaves a
    // scanned folder, because "_Needs Review" is skipped by the scan (see runReceiptAutomation),
    // so a move-then-failed-alert would strand the receipt with nobody told.
    const qboMime = normalizeMime_(file.getMimeType());
    if (QBO_OK_MIMES.indexOf(qboMime) === -1 && qboMime !== "text/plain") {
      if (!state.badFormat) {
        state.badFormat = true;
        setState(file, state);
      }
      // Release an UNBOOKED dedup claim so a re-saved JPG of this same purchase isn't
      // quarantined against it. Guard on "!emailing" (not "!emailed"): once a send was
      // even ATTEMPTED, QBO may hold the copy, so the claim must stay.
      if (!state.emailing) releaseDedupClaims_(state, file.getId());
      sendBadFormatAlertIfNeeded(file, state, ctx, originalName, qboMime);
      file.moveTo(needsReview);
      // Beacon after the move — the park must never wait on the endpoint.
      reportStageBeacon_(file, "read", "parked", "unsupported-format:" + qboMime, { projectName: ctx.projectName });
      Logger.log(" > [UNSUPPORTED FOR QBO] " + qboMime + " — parked in " + NEEDS_REVIEW_NAME);
      return;
    }

    // 1. AI ANALYSIS — reuse saved data if a previous run already extracted it
    let aiData = state.data || null;
    if (!aiData) {
      // Bank this pass as "busy" BEFORE the call, and refund it once we get a decisive
      // answer. state.runs was already persisted above, and an all-busy analysis burns
      // ~2 minutes of backoff against a 6-minute execution limit — so a trigger killed
      // mid-analysis would otherwise charge a run for a pass that learned nothing, and
      // enough of those would still park a readable receipt. Erring toward "busy" only
      // ever costs extra retries; erring the other way costs the receipt.
      const busyBefore = Number(state.busyPasses) || 0;
      state.busyPasses = busyBefore + 1;
      setState(file, state);

      aiData = analyzeDriveFileWithGemini(file, ctx);

      // Gemini was unreachable, not defeated by the document. The provisional count above
      // stands, no strike is charged, and the file stays in intake for the next trigger.
      if (aiData === AI_UNAVAILABLE) {
        Logger.log(" > [SERVICE BUSY] Gemini unavailable — no strike charged (busy pass " +
                   state.busyPasses + "/" + MAX_BUSY_PASSES + "). Will retry next pass.");
        return;
      }

      // Decisive outcome, so this pass DID do real work — refund the provisional busy pass.
      // The refund rides along with the writes below rather than costing its own setState.
      state.busyPasses = busyBefore;

      if (!aiData) {
        state.attempts = (state.attempts || 0) + 1;
        setState(file, state);
        Logger.log(" > [RETRY LATER] AI attempt " + state.attempts + "/" + MAX_AI_ATTEMPTS + " failed.");
        return;
      }
      const saved = trimForState(aiData); // tiny payload now (no line items)
      if (saved) state.data = saved;
      state.attempts = 0;
      setState(file, state);
    }

    const docType = String(aiData.doc_type || "receipt").toLowerCase();
    const isCheck = docType === "check";

    // 1.5 MULTI-DOCUMENT — several receipts/checks scanned into ONE file. The bot
    // books exactly ONE transaction per file, so booking page 1 would silently lose
    // the rest. Multi-receipt PDFs are AUTO-SPLIT into one child file per transaction
    // (v3.2); anything the split can't safely verify falls back to park + "split me".
    if (docType === "multi") {
      if (tryAutoSplitMultiDoc(file, ctx, archive, originalName)) return;
      const multiMsg = parkAlertMessage_(PARK_MULTI_DOC, file, state, ctx, originalName, aiData);
      parkWithAlert_(file, state, PARK_MULTI_DOC, multiMsg.subject, multiMsg.body, needsReview);
      Logger.log(" > [MULTI-DOC] auto-split not possible — parked in " + NEEDS_REVIEW_NAME + ".");
      return;
    }

    // 1.75 NON-RECEIPT — payroll advances, payment-app screenshots, transfers,
    // and chats do not belong in the purchase-receipt flow. Persist classification
    // before moving/emailing so a side-effect failure cannot send it to QBO later.
    if (docType === "non_receipt") {
      state.nonReceipt = true;
      setState(file, state);

      // DEDUP BEFORE PARKING (fixed 2026-08-19). This branch used to return here
      // WITHOUT ever claiming a dedup key - the claim lives ~60 lines further down,
      // past this early return. So a payroll screenshot was treated as brand new on
      // every 10-minute pass: the same $973.25 CJ Havens PDF alerted at 2:59pm and
      // again at 3:10pm and landed in _Needs Review twice, byte-identical.
      // Left alone it emails forever and breeds copies.
      //
      // A non-receipt has no invoice number, so the strong key is unavailable; the
      // weak key (vendor + date + amount) is the right identity. Claiming it makes
      // the SECOND copy recognise the first as owner and stay silent.
      var nrVendor = sanitize(aiData && aiData.vendor) || "Unknown";
      var nrDateRaw = normalizeDateStr(aiData && aiData.date);
      var nrDate = isValidDate(nrDateRaw) ? nrDateRaw : driveDateStr(file);
      var nrAmount = cleanMoney(aiData && aiData.total_amount);
      // Only claim when the identity is REAL. A null/garbage vendor or a 0.00
      // amount collapses every unreadable non-receipt onto ONE key, so the second
      // payroll screenshot of the day gets silently swallowed as a duplicate of an
      // unrelated one. Better to alert twice than to lose a document. (Kimi.)
      var nrIdentityUsable = isValidDate(nrDate) &&
                             nrVendor !== "Unknown" && nrVendor.length > 2 &&
                             nrAmount && nrAmount !== "0.00";
      if (!state.dedupWeakOwned && nrIdentityUsable) {
        // NAMESPACED so a non-receipt can never block a real purchase.
        // (Kimi BLOCKER: the first version claimed the ordinary weak key
        // vendor|date|amount. A payroll advance to Charles Havens for $973.25
        // on 08-19 would then permanently quarantine a genuine receipt sharing
        // those three values - and because this branch never calls
        // releaseDedupClaims_, the block is FOREVER. A silently unbooked expense
        // is far worse than the duplicate email this fix set out to stop.)
        var nrKey = dedupPropKey("nonreceipt|" + makeWeakDedupKey(nrVendor, nrDate, nrAmount));
        state.dedupWeakPk = nrKey; // persist BEFORE claiming so a crash cannot orphan it
        setState(file, state);
        var nrOwner = claimDedupKey(nrKey, file.getId(), nrAmount);
        if (nrOwner) {
          // An earlier copy already owns this identity. Park quietly - alerting
          // again is the exact noise this fix exists to stop.
          state.duplicateOf = nrOwner.fileId;
          state.nonReceiptAlerted = true;
          setState(file, state);
          file.moveTo(needsReview);
          Logger.log(" > [NON-RECEIPT DUPLICATE] already owned by " + nrOwner.fileId + " - parked silently, no second alert.");
          return;
        }
        state.dedupWeakOwned = true;
        setState(file, state);
      }

      sendNonReceiptAlertIfNeeded(file, state, ctx, originalName);
      file.moveTo(needsReview);
      Logger.log(" > [NON-RECEIPT] parked in " + NEEDS_REVIEW_NAME + "; route to payroll (Gusto).");
      return;
    }

    // 2. CLEAN + VALIDATE
    const cleanProject = sanitize(ctx.projectName);
    const cleanVendor  = sanitize(aiData.vendor) || "Unknown";
    // DATE: read off the document (normalized — tolerates trailing spaces / an ISO
    // timestamp); if unreadable, fall back to the Drive UPLOAD date.
    const aiDate       = normalizeDateStr(aiData.date);
    const dateStr      = isValidDate(aiDate) ? aiDate : driveDateStr(file);
    const totalAmount  = cleanMoney(aiData.total_amount);
    const checkNum     = sanitize(aiData.check_number) || "NoNum";
    const cleanInv     = isCheck ? ("Check" + checkNum) : (sanitize(aiData.invoice) || "NoInv");
    const memo         = (aiData.memo || "").toString().trim();

    // Refunds are legitimate documents and continue through rename/dedup/archive,
    // but their state must be durable before any QBO send is attempted.
    if (Number(totalAmount) < 0 && !state.refund) {
      state.refund = true;
      setState(file, state);
    }

    // 2.5 UNREADABLE TOTAL — a $0.00 total is almost always a misread (you don't get
    // a $0 receipt or write a $0 check). Don't email a junk $0 doc to QBO or let it
    // poison the dedup key — park it for a human to read the faded amount.
    if (totalAmount === "0.00") {
      const zeroMsg = parkAlertMessage_(PARK_ZERO_TOTAL, file, state, ctx, originalName, aiData);
      parkWithAlert_(file, state, PARK_ZERO_TOTAL, zeroMsg.subject, zeroMsg.body, needsReview);
      Logger.log(" > [UNREADABLE TOTAL] $0.00 — parked in " + NEEDS_REVIEW_NAME);
      return;
    }

    // 3. RENAME first, so QBO + Drive both carry the project + clean data
    const ext = getExtension(originalName, file.getMimeType());
    const newName = cleanProject + "_" + dateStr + "_" + cleanVendor + "_" + cleanInv + "_$" + totalAmount + ext;
    if (file.getName() !== newName) file.setName(newName);

    // Read succeeded — one journey beacon per file (retry passes reuse the
    // persisted extraction, so re-beaconing would duplicate the step).
    if (!state.readBeaconed) {
      state.readBeaconed = true;
      setState(file, state);
      reportStageBeacon_(file, "read", "ok", "", {
        vendor: aiData.vendor || "",
        projectName: ctx.projectName,
        amountCents: Math.round(Number(totalAmount) * 100),
        taxCents: Math.round(Number(cleanMoney(aiData.tax_amount)) * 100)
      });
    }

    // 4. CONTENT DEDUP — collapse the same purchase arriving as DIFFERENT Drive files
    // (a field photo + a vendor email + the store portal). The FIRST file to reach
    // this step claims the key; a later identical doc is quarantined WITHOUT a second
    // QBO email. Only dedup when the key has a RELIABLE discriminator: a real OCR date
    // AND a real invoice/check number (otherwise we'd collide unrelated docs or miss
    // true copies across days). The claim runs under a script lock so two overlapping
    // trigger runs can't both win the same key.
    const dateReliable = isValidDate(aiDate);
    const refReliable  = isCheck ? (cleanInv !== "CheckNoNum" && refLooksReal_(checkNum))
                                 : (cleanInv !== "NoInv" && refLooksReal_(cleanInv));
    if (!state.emailed && !state.dedupOwned && dateReliable && refReliable) {
      const pk = dedupPropKey(makeDedupKey(dateStr, cleanInv));
      state.dedupPk = pk; // persist BEFORE claiming so a crash can't orphan the key
      setState(file, state);
      const owner = claimDedupKey(pk, file.getId(), totalAmount);
      if (owner) {
        state.duplicateOf = owner.fileId;
        // Matching totals leave nothing to decide: same day, same invoice/check number, same
        // money — quarantine silently, as before. Disagreeing totals are the one case this
        // key cannot settle alone. It is either ONE purchase with a misread total (so which
        // figure booked?) or, now that the vendor is out of the key, two unrelated vendors
        // reusing an invoice number on one day (so quarantining would silently drop a real
        // expense). Both need a human. A claim written before v3.6 carries no total to
        // compare, so it reads as "can't confirm" and is reviewed too.
        if (owner.amount !== totalAmount) {
          state.dedupWeak = true;
          state.dedupWeakReason = owner.amount
            ? "the same invoice/check number on the same date, but a DIFFERENT total ($" +
              owner.amount + " on that one vs $" + totalAmount + " on this one)"
            : "the same invoice/check number on the same date";
          setState(file, state);
          sendWeakDuplicateAlertIfNeeded(file, state, newName);
          file.moveTo(needsReview);
          reportStageBeacon_(file, "dedupe", "parked", "possible-duplicate-of:" + owner.fileId);
          Logger.log(" > [POSSIBLE DUPLICATE of file " + owner.fileId + "] " + newName + " — totals disagree; parked in " + NEEDS_REVIEW_NAME + ".");
          return;
        }
        setState(file, state);
        const dupFolder = getOrCreateFolder(archive, DUPLICATES_NAME);
        file.moveTo(dupFolder);
        reportStageBeacon_(file, "dedupe", "quarantined", "duplicate-of:" + owner.fileId);
        Logger.log(" > [DUPLICATE of file " + owner.fileId + "] " + newName + " — quarantined to " + DUPLICATES_NAME + ", skipped QBO.");
        return;
      }
      state.dedupOwned = true;
      setState(file, state);
    }
    // WEAK NET — deliberately NOT an "else". It also has to cover documents that DID take an
    // authoritative claim above, because the ref is exactly what drifts on the Lowe's pair
    // (order # 201632205261901943 on one mail, invoice # 160992 on the other) and those two
    // never meet on the authoritative key. A collision here never enters the _Duplicates
    // quarantine — two genuine same-day, same-amount buys from one vendor are perfectly
    // ordinary, so this only ever asks a human.
    if (!state.emailed && !state.dedupWeakOwned && dateReliable && totalAmount !== "0.00") {
      const wpk = dedupPropKey(makeWeakDedupKey(cleanVendor, dateStr, totalAmount));
      state.dedupWeakPk = wpk;
      setState(file, state); // persist BEFORE claiming so a crash can't orphan the key
      const owner = claimDedupKey(wpk, file.getId(), totalAmount);
      if (owner) {
        state.dedupWeak = true;
        state.duplicateOf = owner.fileId;
        state.dedupWeakReason = "the same vendor, date, and amount";
        setState(file, state);
        // Hand back the authoritative claim this file may have just taken. It is going to
        // "_Needs Review", which the scan skips, so the bot will never send it — and a claim
        // held by a file that can no longer book is worse than no claim at all: the next
        // genuine copy of this purchase would be silently quarantined against it and never
        // book either. Same rule as the give-up path, and equally gated on "!emailing".
        if (!state.emailing) releaseDedupClaims_(state, file.getId());
        sendWeakDuplicateAlertIfNeeded(file, state, newName);
        file.moveTo(needsReview);
        Logger.log(" > [POSSIBLE DUPLICATE of file " + owner.fileId + "] " + newName + " — parked in " + NEEDS_REVIEW_NAME + ".");
        return;
      }
      state.dedupWeakOwned = true;
      setState(file, state);
    }

    // 5. EMAIL TO QUICKBOOKS
    // At-least-once AND at-most-once across overlapping runs. The whole decision runs
    // under a script lock and RE-READS the persisted state, so if another execution
    // (a run that overran the 10-min interval) already sent this file, this run sees
    // it and skips — two runs can't both email the same document. "emailing" is marked
    // BEFORE the send; a crash mid-send leaves emailing=true/emailed=false so the next
    // pass re-sends WITH a duplicate warning.
    // AMAZON: the native Intuit "Amazon Business Purchases" app (connected 2026-08-14)
    // is the single writer for Amazon in QuickBooks. The bot must NOT also book these —
    // two writers on one vendor is exactly how duplicates happen. The file still
    // archives to the Drive receipt archive below (source of truth for
    // expense-by-project) and keeps its dedup claim so stray copies cannot book either.
    // Flip to false to hand booking back to the bot.
    const AMAZON_APP_OWNS_BOOKING = true;
    if (AMAZON_APP_OWNS_BOOKING && !state.emailed &&
        /amazon|amzn/i.test(String((aiData && aiData.vendor) || ""))) {
      if (!state.amazonAppOwned) {
        state.amazonAppOwned = true;
        setState(file, state);
      }
      Logger.log(" > [AMAZON] Booking owned by the Amazon Business QBO app — archiving only, no QBO send.");
    } else if (!state.emailed || (state.refund && !state.refundAlerted)) {
      const sendLock = RECEIPT_RUN_LOCK_HELD_ ? null : LockService.getScriptLock();
      if (sendLock) sendLock.waitLock(30000);
      try {
        const fresh = getState(file); // authoritative copy — any concurrent run writes here
        if (!fresh.emailed) {
          const possibleDuplicate = !!fresh.emailing;
          // Build the attachment BEFORE marking "emailing". For a text/plain file this is a
          // PDF conversion, which can fail on the daily conversion quota — and if that threw
          // after the flag was persisted, nothing would be mailed yet the dedup key would
          // stay held, so no later copy of the purchase could book either. Constructing it
          // first means a conversion failure is a clean no-op that simply retries next pass.
          const attachment = qboAttachment_(file);
          if (!attachment) throw new Error("UNSUPPORTED_FOR_QBO: " + file.getMimeType());

          // Same reasoning as the attachment, one step earlier — and this is what keeps
          // "emailing" a trustworthy signal. If the daily mail quota is already gone this
          // send CANNOT go out, and learning that from a thrown MailApp call would be too
          // late: "emailing" would already be persisted, so the dedup key would stay held
          // and every later copy of a purchase that never booked would be quarantined
          // against it. Note what we do NOT do: treat a thrown send as proof of
          // non-delivery. MailApp.sendEmail returns void and gives no dispatch receipt, so
          // an exception could in principle surface after the message was already queued,
          // and releasing the claim on that guess would double-book the expense. Asking
          // BEFORE dispatching is the only version of this we can actually prove — quota
          // exhaustion becomes a clean no-op that retries next pass. "emailing" then means
          // "a send may have reached QuickBooks", which OVER-approximates (an execution
          // killed between this setState and the MailApp call leaves it set having sent
          // nothing) — that is the safe direction: it holds the dedup claim rather than
          // releasing one on a document QBO might have.
          if (MailApp.getRemainingDailyQuota() <= 0) {
            throw new Error("MAIL_QUOTA_EXHAUSTED: no sends left today — retrying next pass.");
          }

          fresh.emailing = true;
          setState(file, fresh);

          // Primary: ProBuild API creates the QBO Purchase (job-coded line +
          // attachment, bank-match ready). Falls back to the legacy email send
          // internally on any terminal decline; throws on transient failures so
          // this pass retries — see sendToQBOviaAPI.js.
          sendReceiptToQuickBooksViaAPI(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment, fresh);

          fresh.emailed = true;
          setState(file, fresh);
        }
        sendRefundAlertIfNeeded(file, fresh, ctx, aiData, totalAmount, dateStr);
        state = fresh; // keep local state in sync for the steps below
      } finally {
        if (sendLock) sendLock.releaseLock();
      }
    }

    // 6. ARCHIVE to Year/Month
    const year = dateStr.split("-")[0];
    const monthNum = parseInt(dateStr.split("-")[1], 10);
    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const monthName = monthNames[monthNum - 1] || "Unknown";
    const yearFolder  = getOrCreateFolder(archive, year);
    const monthFolder = getOrCreateFolder(yearFolder, monthName);
    file.moveTo(monthFolder);

    Logger.log(" > [SUCCESS] " + (isCheck ? "Check #" + checkNum : "Receipt") + " emailed to QBO, archived to " + year + "/" + monthName);

  } catch (e) {
    Logger.log(" > [ERROR] Failed on " + originalName + ": " + e.toString());
  }
}

/**
 * Park a file in "_Needs Review" with its alert — durably, and in the only safe order.
 *
 * "_Needs Review" starts with "_" and is SKIPPED by the folder scan (see
 * runReceiptAutomation), so a file that lands there is invisible to the trigger forever.
 * Moving BEFORE the alert therefore turns one failed MailApp call into a lost receipt:
 * not in QuickBooks, and nobody told. The mail quota is the realistic trigger — this bot
 * sends several alerts per run and the daily MailApp limit is shared across all of them —
 * so "the alert throws" is a routine event, not a freak one.
 *
 * The order, and why each step sits where it does:
 *   1. persist the terminal reason — from here on NO pass may send this file to QBO, even
 *      if both the alert and the move go on to fail
 *   2. send the alert             — while the file is still in a SCANNED folder, so a
 *      failure is retried rather than lost
 *   3. persist the "alerted" flag — so retrying step 4 can't re-send the alert
 *   4. move                       — last, because this is the step that hides the file
 *
 * Any failure throws with the file still in its scanned folder; the next run re-enters at
 * the terminal-park check in processSingleFile and retries only the steps that have not
 * succeeded. Steps 2 and 3 are not atomic, so a crash between them re-sends the alert on
 * the next pass — the same at-least-once trade the other alert helpers make, and the right
 * one here: a duplicate email costs Marge a glance, a missed one costs a receipt.
 */
/**
 * Should this file stop being retried, and if so under which reason?
 *
 * Pulled out of processSingleFile so the arithmetic can be tested directly instead of a
 * test re-implementing it (a duplicated guard passes happily while the real one drifts).
 *
 * Passes lost to an unavailable Gemini are SUBTRACTED from the run count: they never got
 * far enough to learn anything about this file, so charging them would park a perfectly
 * readable receipt for the service's bad day. They carry their own, more patient ceiling.
 *
 * Counters are coerced with Number(): a corrupted description (state lives in the Drive
 * file's description field, which a human can edit) could otherwise make every comparison
 * NaN — which is false — and a file would retry forever with nobody ever told.
 */
function shouldGiveUp_(state) {
  const attempts    = Number(state.attempts)   || 0;
  const runs        = Number(state.runs)       || 0;
  const busyPasses  = Number(state.busyPasses) || 0;
  const chargedRuns = Math.max(0, runs - busyPasses);

  const outOfAttempts = attempts   >= MAX_AI_ATTEMPTS;
  const outOfRuns     = chargedRuns >= MAX_TOTAL_RUNS;
  const outOfPatience = busyPasses >= MAX_BUSY_PASSES;

  // WHICH reason is true changes what a human should do. "The AI never managed to read this"
  // means the document is probably fine and worth re-dropping once Gemini recovers. It is
  // only honest when NOTHING was ever decisively learned about the file — one real read
  // failure and the generic give-up (which reports both counts) is the truthful message.
  const reason = (outOfPatience && attempts === 0 && !outOfRuns)
    ? PARK_AI_UNAVAILABLE
    : PARK_GAVE_UP;

  return { giveUp: outOfAttempts || outOfRuns || outOfPatience, reason: reason };
}

function parkWithAlert_(file, state, reasonKey, subject, body, needsReview) {
  const firstParkForReason = state.parkReason !== reasonKey;
  if (firstParkForReason) {
    state.parkReason = reasonKey;
    setState(file, state);
  }
  if (!state.parkAlerted) {
    MailApp.sendEmail(ALERT_EMAIL, subject, body);
    state.parkAlerted = true;
    setState(file, state);
  }
  file.moveTo(needsReview);
  // Beacon LAST: the park (state + alert + move) must complete even if the
  // Command Center endpoint is stalled — a blocked fetch here could otherwise
  // burn the execution budget before the file was actually parked.
  if (firstParkForReason) reportStageBeacon_(file, "read", "parked", reasonKey);
}

/**
 * The alert text for each terminal park reason, built from persisted state so that a retry
 * pass sends the SAME message the first attempt would have. Call sites use this too, which
 * keeps each reason's wording in exactly one place.
 *
 * aiData is passed by the original call site because trimForState() can decline to persist
 * an oversized extraction (state.data stays unset); on a retry pass there is only state.data
 * to work from, and the message degrades to "Unknown" rather than lying about the vendor.
 */
function parkAlertMessage_(reasonKey, file, state, ctx, fileName, aiData) {
  const d = aiData || state.data || {};

  if (reasonKey === PARK_ZERO_TOTAL) {
    const zeroAiDate = normalizeDateStr(d.date);
    const zeroDate = isValidDate(zeroAiDate) ? zeroAiDate : driveDateStr(file);
    return {
      subject: "Receipt bot: unreadable amount — " + (d.vendor || "Unknown") + " (" + ctx.projectName + ")",
      body:
        'The total on "' + fileName + '" could not be read (came through as $0.00), so it was NOT sent to QuickBooks.\n' +
        "Vendor: " + (d.vendor || "Unknown") + "\n" +
        "Date:   " + zeroDate + "\n" +
        "Job:    " + ctx.projectName + "\n" +
        'Moved to "' + NEEDS_REVIEW_NAME + '" — please read the amount off the document and enter it in QuickBooks manually.'
    };
  }

  if (reasonKey === PARK_MULTI_DOC) {
    return {
      subject: "Receipt bot: multiple receipts in one file — " + fileName,
      body:
        '"' + fileName + '" (' + ctx.projectName + ") contains MORE THAN ONE receipt or check scanned together.\n" +
        "Auto-split wasn't possible (not a PDF, too many pages, or the AI couldn't map every page to a transaction),\n" +
        "so it was NOT sent to QuickBooks — booking one page would silently drop the others.\n" +
        "Please split it into one file per receipt and drop each into the right project folder; they will then process normally.\n" +
        'The file was moved to "' + NEEDS_REVIEW_NAME + '".'
    };
  }

  if (reasonKey === PARK_AI_UNAVAILABLE) {
    return {
      subject: "Receipt bot: AI unavailable, receipt not read — " + fileName,
      body:
        '"' + fileName + '" (' + ctx.projectName + ") was never read, because the AI service was\n" +
        "unavailable on every one of " + MAX_BUSY_PASSES + " attempts (overloaded, rate-limited, or a key/quota\n" +
        "problem). This is NOT a problem with the document — as far as the bot knows the receipt\n" +
        "is perfectly readable, it simply never got a chance to look at it.\n\n" +
        "In QuickBooks: NO — it was never sent.\n\n" +
        'The file was moved to "' + NEEDS_REVIEW_NAME + '". Two options:\n' +
        "  1. Drop it back into its project folder once the AI is healthy and it will process normally, or\n" +
        "  2. Enter it in QuickBooks by hand if you'd rather not wait.\n" +
        "If this alert arrives for many files at once, the AI key or its quota is the thing to check."
    };
  }

  // PARK_GAVE_UP (and any unrecognised reason, so a park never falls through un-alerted).
  // Be precise about QBO status so a human can't safely ignore this: a send may have been
  // ATTEMPTED but not confirmed (emailing set, emailed not), in which case the dedup key
  // stays held and later copies auto-skip — so THIS one must be reconciled/booked from here.
  // The claim note is conditioned on the claim actually still being held (the caller
  // releases it when no send was attempted), because promising "later copies will be
  // auto-skipped" after a release would send Marge looking for a quarantine that isn't there.
  const qboStatus = state.emailed
    ? "YES — already in QuickBooks; do NOT forward it again."
    : (state.emailing
        ? "MAYBE — a send was attempted but interrupted, so it may or may not have reached QuickBooks. CHECK QuickBooks; if it's not there, enter it manually."
        : "NO — it never reached QuickBooks; enter it manually.");
  const dupNote = ((state.dedupOwned || state.dedupWeakOwned) && !state.emailed && state.emailing)
    ? "\nNote: later duplicate copies of this purchase will be auto-skipped, so this one must be booked from here." : "";
  return {
    subject: "Receipt bot needs help: " + fileName,
    body:
      'Could not finish processing "' + fileName + '" (' + ctx.projectName + ").\n" +
      "Failed AI reads: " + (state.attempts || 0) + " | Total passes: " + (state.runs || 0) + "\n" +
      "In QuickBooks: " + qboStatus + dupNote + "\n" +
      'It was moved to "' + NEEDS_REVIEW_NAME + '" — please handle it manually.'
  };
}

/**
 * Send the distinct non-receipt alert before parking. The persisted flag lets a
 * later move retry skip an already-successful notification.
 */
function sendNonReceiptAlertIfNeeded(file, state, ctx, fileName) {
  if (state.nonReceiptAlerted) return false;
  MailApp.sendEmail(ALERT_EMAIL,
    "Receipt bot: payroll / payment-app item — " + fileName,
    'The file "' + fileName + '" (' + ctx.projectName + ") was NOT sent to QuickBooks because " +
    "this looks like a payroll / payment-app item — route it to payroll (Gusto), not the receipt inbox.\n" +
    'It will be moved to "' + NEEDS_REVIEW_NAME + '" for manual routing.');
  state.nonReceiptAlerted = true;
  setState(file, state);
  return true;
}

/**
 * Send the unsupported-format alert before parking. The persisted flag lets a later move
 * retry skip an already-successful notification.
 *
 * The QuickBooks line has to be state-aware: a file can reach here having ALREADY been
 * forwarded under an older version (a HEIC that Intuit then bounced), and telling the
 * bookkeeper "it was not sent" when a send was attempted would be worse than saying
 * nothing — they'd book it a second time.
 */
function sendBadFormatAlertIfNeeded(file, state, ctx, fileName, mime) {
  if (state.badFormatAlerted) return false;

  // The format gate runs BEFORE the AI, so there is usually no extraction to quote. But a
  // file that already went through an older version has its reading persisted in the state
  // — include it when present, because without an amount "book it by hand" is not an
  // instruction anyone can act on.
  const d = state.data || {};
  const known = (d.vendor || d.date || d.total_amount)
    ? "What the bot had already read off it:\n" +
      "  Vendor: " + (d.vendor || "unknown") + "\n" +
      "  Date:   " + (normalizeDateStr(d.date) || d.date || "unknown") + "\n" +
      "  Amount: $" + (cleanMoney(d.total_amount) || "unknown") + "\n\n"
    : "The bot did not read the document (the format is rejected before that step), so there\n" +
      "are no vendor/date/amount details to quote here — they're on the receipt itself.\n\n";

  // A retained dedup claim changes the instruction completely: a re-saved copy would be
  // quarantined to _Duplicates rather than booked, so promising "it will process normally"
  // would be actively misleading. The claim is only released when no send was attempted.
  const claimHeld = (!!state.dedupPk || !!state.dedupWeakPk) && !!state.emailing;
  const qboStatus = state.emailed
    ? "A send DID go out, but QuickBooks could not read the attachment — so the expense may\n" +
      "   exist with no document, or not at all. Check QuickBooks before re-entering it."
    : (state.emailing
        ? "A send was ATTEMPTED but interrupted, so it may or may not have reached QuickBooks.\n" +
          "   Check QuickBooks first."
        : "It was NOT sent to QuickBooks.");

  const nextStep = claimHeld
    ? "IMPORTANT: the duplicate guard is still held for this purchase, so re-saving and\n" +
      "dropping the file back will NOT book it — it would be filed as a duplicate instead.\n" +
      "Enter this one in QuickBooks by hand once you've confirmed it isn't already there."
    : "If this IS a purchase receipt, re-save it as a JPG or PDF and drop it back into the same\n" +
      "project folder — it will then process normally. (iPhone photos are often .heic, and images\n" +
      "shared through Google Chat or Photos arrive as .webp; exporting or sharing as JPG fixes both.)\n\n" +
      "But if it is a screenshot of a payment app (Cash App, Venmo, Zelle), a payroll advance, or a\n" +
      "bank transfer, DON'T bother converting it — the bot rejects those on purpose and always will,\n" +
      "because they aren't purchase receipts. Payroll advances belong in Gusto, and payment-app\n" +
      "history belongs with the bookkeeping records, not in the receipts folder.";

  MailApp.sendEmail(ALERT_EMAIL,
    "Receipt bot: QuickBooks can't read this file type — " + fileName,
    'The file "' + fileName + '" (' + ctx.projectName + ") is a " + mime + ", which the QuickBooks\n" +
    "receipt inbox cannot read. It accepts PDF, JPG, and PNG only.\n\n" +
    "QuickBooks status: " + qboStatus + "\n\n" +
    known +
    nextStep + "\n" +
    'The file was moved to "' + NEEDS_REVIEW_NAME + '".');
  state.badFormatAlerted = true;
  setState(file, state);
  return true;
}

/**
 * Send the weak-collision review alert before parking. The prior owner's claim is
 * only read here; this file never releases or takes ownership of that claim.
 *
 * WHICH fields matched is read from state, not passed in: the terminal-retry path re-sends
 * this alert from a pass that no longer has the collision in scope, and "matches by vendor,
 * date, and amount" on a totals-disagree hit would point Marge at the wrong thing.
 */
function sendWeakDuplicateAlertIfNeeded(file, state, fileName) {
  if (state.weakDuplicateAlerted) return false;
  const owner = state.duplicateOf;
  let ownerName = "Drive file " + owner;
  try { ownerName = DriveApp.getFileById(owner).getName(); }
  catch (ownerErr) { Logger.log(" > [WARN] could not resolve weak-dedup owner name: " + ownerErr); }
  MailApp.sendEmail(ALERT_EMAIL,
    "Receipt bot: possible duplicate needs review — " + fileName,
    'The file "' + fileName + '" matches the earlier file "' + ownerName + '" by ' +
    (state.dedupWeakReason || "vendor, date, and amount") + ".\n" +
    "This is a possible duplicate — verify in QuickBooks before booking.\n" +
    "It was NOT sent to QuickBooks and will be moved to \"" + NEEDS_REVIEW_NAME + "\".");
  state.weakDuplicateAlerted = true;
  setState(file, state);
  return true;
}

/**
 * Send the required refund/credit alert once its QBO email is confirmed. The flag
 * is deliberately written only after MailApp succeeds, giving at-least-once alerting.
 */
function sendRefundAlertIfNeeded(file, state, ctx, aiData, totalAmount, dateStr) {
  if (!state.emailed || !state.refund || state.refundAlerted) return false;
  MailApp.sendEmail(ALERT_EMAIL,
    "Receipt bot REFUND / CREDIT: " + (aiData.vendor || "Unknown") + " ($" + totalAmount + ")",
    "A refund was sent to the QuickBooks receipt inbox. Verify that it is booked as a CREDIT, not an expense.\n" +
    "Vendor: " + (aiData.vendor || "Unknown") + "\n" +
    "Date:   " + dateStr + "\n" +
    "Amount: $" + totalAmount + "\n" +
    "Job:    " + ctx.projectName);
  state.refundAlerted = true;
  setState(file, state);
  return true;
}

/**
 * Email the document to the QBO receipt-forwarding inbox. Subject + body lead with
 * the PROJECT (the folder it was filed in) so Marge can assign it in QuickBooks.
 */
function sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment) {
  let subject, header, extraRows;
  if (isCheck) {
    subject = ctx.projectName + " - Check #" + checkNum + " - " + (aiData.vendor || "Unknown") + " ($" + totalAmount + ")";
    header  = "New Check Processed";
    extraRows = "<p><b>Check #:</b> " + checkNum + "</p>" +
                "<p><b>Memo (what it's for):</b> " + (memo || "&lt;no memo written&gt; — please categorize in QBO") + "</p>";
  } else {
    const catNote = ctx.category ? " - " + displayCategory(ctx.category) : "";
    subject = ctx.projectName + catNote + " - " + (sanitize(aiData.vendor) || "Unknown") + " ($" + totalAmount + ")";
    header  = "New Receipt Processed";
    extraRows = "<p><b>Invoice:</b> " + (aiData.invoice || "NoInv") + "</p>";
  }

  const dupWarning = possibleDuplicate
    ? '<p style="color:red"><b>⚠ POSSIBLE DUPLICATE:</b> the previous run was interrupted mid-send. If this document already arrived, ignore this copy.</p>'
    : "";

  const refundWarning = Number(totalAmount) < 0
    ? '<p style="color:red;font-size:18px"><b>REFUND / CREDIT — This must be booked as a CREDIT, not an expense.</b></p>'
    : "";
  if (Number(totalAmount) < 0) subject = "REFUND / CREDIT — " + subject;

  const hint = ctx.isShop
    ? "<p><b>Filed under:</b> Shop / Overhead" + (ctx.category ? " — " + displayCategory(ctx.category) : "") + "</p>"
    : "<p><b>Project:</b> " + ctx.projectName + "</p>";

  // Last line of defence on the format. The caller builds the attachment (before it marks
  // "emailing", so a conversion failure can't strand the file) and step 0.5 has already
  // parked anything unsupported — so a missing blob here means a caller bypassed both.
  // Throw rather than mail something Intuit drops, which books nothing and warns no one.
  const blob = attachment || qboAttachment_(file);
  if (!blob) throw new Error("UNSUPPORTED_FOR_QBO: " + file.getMimeType());

  MailApp.sendEmail({
    to: QBO_EMAIL_ADDRESS,
    subject: subject,
    htmlBody:
      refundWarning + "<h3>" + header + "</h3>" + dupWarning +
      "<p><b>" + (isCheck ? "Payee" : "Vendor") + ":</b> " + (aiData.vendor || "Unknown") + "</p>" +
      "<p><b>Date:</b> " + dateStr + "</p>" +
      "<p><b>Amount:</b> $" + totalAmount + "</p>" +
      hint + extraRows,
    name: "Golden Touch AI",
    attachments: [blob]
  });
}

/**
 * The blob actually attached to the QBO email. PDF/JPG/PNG pass straight through; a text
 * file is rendered to PDF (covers .txt files already sitting in Drive from before v3.4).
 * Returns null for anything else — Apps Script cannot decode HEIC/WEBP, so there is no
 * honest conversion to offer and the caller must refuse to send.
 */
function qboAttachment_(file) {
  const mime = normalizeMime_(file.getMimeType());
  // getBlob(), NOT getAs(mime): the bytes are already in an accepted format, so asking for
  // a conversion only risks a needless quota/conversion failure AFTER emailing=true has
  // been persisted — which would leave the dedup key held and the receipt unbooked.
  if (QBO_OK_MIMES.indexOf(mime) > -1) return file.getBlob();
  if (mime === "text/plain") return textToPdfBlob_(file.getBlob().getDataAsString(), file.getName());
  return null;
}

// Drive usually returns a bare media type, but "text/plain; charset=utf-8" would slip past
// an exact-match check and be treated as an unreadable format. Strip any parameters.
function normalizeMime_(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}

/**
 * Gemini: read vendor / date / amount (+ check #, memo). No categorizing — Marge
 * does that inside QuickBooks.
 */
function analyzeDriveFileWithGemini(file, ctx) {
  const MAX_RETRIES = 5;
  const mimeType = normalizeMime_(file.getMimeType());
  let payloadPart;
  // Declared out here, NOT inside the try below: the final return reads it AFTER the catch,
  // and a block-scoped declaration inside the try throws ReferenceError there instead —
  // which would have turned every busy pass into a crash. See the loop for what it means.
  // "Decisive" = we learned something retrying will not change, whether about the document
  // (unreadable, invalid JSON, rejected payload) or the configuration (no such model).
  let sawDecisiveFailure = false;

  try {
    if (mimeType === "text/plain") {
      payloadPart = { "text": "This is a text file containing receipt data:\n" + file.getBlob().getDataAsString() };
    } else {
      payloadPart = { "inline_data": { "mime_type": mimeType, "data": Utilities.base64Encode(file.getBlob().getBytes()) } };
    }

    const promptText =
      'Role: Bookkeeper for "Golden Touch Remodeling", a residential remodeling contractor.\n' +
      "The attached document may be:\n" +
      "  A) a RECEIPT / INVOICE from a store or vendor,\n" +
      "  B) a photo of a HANDWRITTEN CHECK the business wrote to a subcontractor, or\n" +
      "  C) a NON-RECEIPT such as a payment-app screenshot, payroll advances, a bank-transfer confirmation, or a chat/text-message screenshot.\n\n" +
      'STEP 1 - if the file contains MORE THAN ONE separate receipt, invoice, or check ' +
      "(e.g. several receipts scanned into one PDF, or a sale AND its refund as separate pages), " +
      'return exactly {"doc_type":"multi"} and nothing else. A multi-PAGE document about ONE ' +
      'transaction is fine. Otherwise, for category C return exactly {"doc_type":"non_receipt"} and nothing else. ' +
      'For purchase documents set doc_type to "receipt" or "check".\n' +
      "STEP 2 - extract ONLY these fields:\n" +
      '- RECEIPT: vendor, date, invoice number (or "NoInv"), total_amount, tax_amount. ' +
      "total_amount is the FINAL amount paid — after all discounts, coupons, and credits, and " +
      "including tax and fees. It is the number that will match the bank/card charge. NEVER the " +
      "subtotal, and never the pre-discount price. If the receipt shows both a subtotal and a " +
      "total, use the total. tax_amount is the sales tax shown on the receipt (the TAX line); " +
      'return "" if no tax line is shown or it cannot be read confidently — never estimate or ' +
      "compute it yourself.\n" +
      '- CHECK: vendor = the "PAY TO THE ORDER OF" payee; date; total_amount from the numeric box ' +
      "(cross-check it against the written-out amount line); check_number (printed top-right); " +
      'memo (the handwritten bottom-left "MEMO"/"FOR" line — what the payment is for). ' +
      "Handwriting may be messy — read carefully.\n" +
      'If a field cannot be read, return "" for it. For the date, return "" rather than guessing.\n\n' +
      "OUTPUT FORMAT (Strict JSON):\n" +
      "{\n" +
      '  "doc_type": "receipt, check, multi, or non_receipt",\n' +
      '  "vendor": "String (payee for checks)",\n' +
      '  "date": "YYYY-MM-DD or empty",\n' +
      '  "invoice": "String (or NoInv)",\n' +
      '  "check_number": "String (checks only)",\n' +
      '  "memo": "String (checks only, verbatim memo line)",\n' +
      '  "total_amount": "0.00",\n' +
      '  "tax_amount": "0.00 (receipts only, empty if not shown)"\n' +
      "}";

    const payload = {
      "contents": [{ "parts": [ { "text": promptText }, payloadPart ] }],
      "generationConfig": { "responseMimeType": "application/json" }
    };
    const options = {
      "method": "post", "contentType": "application/json",
      "payload": JSON.stringify(payload), "muteHttpExceptions": true
    };
    // Try each model in order. A model that's overloaded (503) or rate-limited (429)
    // gets MAX_RETRIES backoff attempts; if it's still unavailable, fall through to the
    // next model so one busy model never sinks the read.
    //
    // Returning null for BOTH "the service was busy" and "this document defeated the AI"
    // is what let a busy spell park a readable receipt: the caller could not tell them
    // apart, so it spent a strike either way. Track which kind of failure we actually saw.
    // A definitive failure OUTRANKS an availability one — if any model got a response and
    // still could not produce usable JSON, that is evidence about the document itself, and
    // treating it as "busy" would retry a hopeless file until it hit the busy ceiling.
    for (let mi = 0; mi < GEMINI_MODELS.length; mi++) {
      const model = GEMINI_MODELS[mi];
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + geminiApiKey_();
      let attempts = 0;

      while (attempts < MAX_RETRIES) {
        try {
          const response = UrlFetchApp.fetch(url, options);
          const code = response.getResponseCode();

          if (code === 200) {
            const json = JSON.parse(response.getContentText());
            const cand = json && json.candidates && json.candidates[0];
            const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
            const text = part && part.text;
            // The model answered; it just could not turn THIS document into usable data.
            if (!text) { Logger.log(" > [SERVICE] (" + model + ") returned no text (empty/safety-blocked). Trying next model."); break; }
            try { return JSON.parse(text); }
            catch (parseErr) { Logger.log(" > [SERVICE] (" + model + ") returned invalid JSON: " + parseErr + ". Trying next model."); break; }
          }

          if (code === 429 || code === 503) { // overloaded / rate-limited -> back off, then fall to next model
            attempts++;
            const s = Math.pow(2, attempts) * 1000 + Math.floor(Math.random() * 1000);
            Logger.log(" > [BUSY] " + model + " unavailable (HTTP " + code + "). Retry in " + s + "ms (" + attempts + "/" + MAX_RETRIES + ")...");
            Utilities.sleep(s);
            continue;
          }

          if (code === 404) { // model id not available for this key -> try the next one
            // Decisive, NOT "busy": if every model 404s the project is misconfigured, and
            // quietly retrying that for hours per file would delay the one alert that tells
            // someone to fix it. Still not the document's fault — the alert says so.
            // SERVICE failure - the document was never read, so it must not cost
            // this file an attempt. This line used to set sawDecisiveFailure = true,
            // and that is exactly what parked five legible receipts during the
            // 2026-08-10..19 outage. A 404 on ONE model while another works is
            // harmless - that is what a chain is for.
            Logger.log(" > [SKIP] " + model + " not available (HTTP 404). Trying next model.");
            break;
          }

          // 401/403 (revoked key, blocked project) is a SERVICE failure: the
          // document was never read, so it must not cost this file an attempt.
          // The old code returned null here, arguing a retry would "hide the
          // outage". Wrong twice: the outage was hidden anyway (the alert was
          // email to an unwatched inbox), and surfacing an outage is the
          // WATCHDOG's job, not the retry counter's.
          if (code === 401 || code === 403) {
            Logger.log(" > [SERVICE] " + model + " HTTP " + code + " (auth/project blocked). Trying next model.");
            break;
          }

          // 400 = oversized/undecodable payload. THAT is about this document.
          sawDecisiveFailure = true;
          Logger.log("API Error (Fatal, " + model + "): " + response.getContentText());
          return null;

        } catch (fetchError) {
          attempts++;
          const s = Math.pow(2, attempts) * 1000;
          Logger.log(" > [NET ERROR] " + model + " fetch failed. Retry in " + s + "ms... " + fetchError);
          Utilities.sleep(s);
        }
      }
      Logger.log(" > [FALLBACK] " + model + " exhausted; " + (mi + 1 < GEMINI_MODELS.length ? "trying next model." : "no models left."));
    }
    // Say which of the two it actually was — during an incident the distinction is the
    // whole question, and logging "unavailable" for a document the AI simply couldn't read
    // sends whoever is debugging after the wrong problem.
    Logger.log(sawDecisiveFailure
      ? " > [FAIL] Models responded but none could read this file."
      : " > [FAIL] All models unavailable for this file.");

  } catch (e) {
    // Our own code threw (base64 of an oversized blob is the realistic cause), which is a
    // fact about this file, not about Gemini's availability. Charge it as a read failure.
    Logger.log("Gemini Analysis Failed: " + e.toString());
    return null;
  }
  // Nothing decisive was ever learned — every model failed on availability. Tell the caller
  // so it does not spend one of this file's three strikes on the service's bad day.
  return sawDecisiveFailure ? null : AI_UNAVAILABLE;
}

/**
 * AUTO-SPLIT (v3.2) — break a multi-receipt PDF into one child PDF per transaction.
 *
 * Two steps: (1) Gemini groups the document's pages by transaction; (2) pdf-lib
 * (loaded at runtime from a pinned CDN URL — Apps Script has no native PDF tool)
 * writes each group as its own PDF back into the SAME folder, so the normal
 * pipeline reads/emails/archives each piece next pass with the right project
 * context. The original is archived to "_Split Originals" (NEVER deleted) and a
 * report email lists the pieces so a human can spot-check the bookings.
 *
 * Apps Script quirk: pdf-lib's API is Promise-based and GAS code can't "await"
 * mid-function — but the V8 runtime drains the microtask queue after the top-level
 * function returns, so the .then chain below completes at the end of this
 * execution (the documented community pattern for pdf-lib on GAS). File creation
 * is idempotent (deterministic child names; existing children are reused, never
 * duplicated), so a crash or timeout mid-split simply resumes next pass. ANY
 * doubt (not a PDF, >MAX_SPLIT_PAGES pages, AI page map overlapping/incomplete,
 * CDN or library failure) -> park + manual "split me" email instead.
 */
function tryAutoSplitMultiDoc(file, ctx, archive, originalName) {
  try {
    if (file.getMimeType() !== "application/pdf") return false;
    const map = analyzeMultiPageMapWithGemini(file);
    if (!map || !map.transactions || map.transactions.length < 2) return false;
    // Cheap sanity before touching bytes: positive integer pages, no overlaps.
    const seen = {};
    for (let i = 0; i < map.transactions.length; i++) {
      const pages = map.transactions[i].pages;
      if (!pages || !pages.length) return false;
      for (let j = 0; j < pages.length; j++) {
        const p = pages[j];
        if (typeof p !== "number" || p < 1 || p % 1 !== 0 || seen[p]) return false;
        seen[p] = true;
      }
    }

    const PDFLib = loadPdfLib_();
    const bytes = file.getBlob().getBytes();
    const parent = file.getParents().next();
    const base = originalName.replace(/\.pdf$/i, "");
    const groups = map.transactions;

    PDFLib.PDFDocument.load(bytes).then(function (src) {
      const n = src.getPageCount();
      if (n > MAX_SPLIT_PAGES) throw new Error("too many pages (" + n + " > " + MAX_SPLIT_PAGES + ")");
      // Authoritative partition check against the REAL page count: every page of
      // the document assigned to exactly one transaction, none left behind.
      const cover = {};
      groups.forEach(function (g) {
        g.pages.forEach(function (p) {
          if (p > n || cover[p]) throw new Error("AI page map invalid for a " + n + "-page PDF");
          cover[p] = true;
        });
      });
      if (Object.keys(cover).length !== n) throw new Error("AI page map does not cover all " + n + " pages");
      // One child document per transaction, built sequentially (memory-friendly).
      let seq = Promise.resolve([]);
      groups.forEach(function (g, gi) {
        seq = seq.then(function (acc) {
          return PDFLib.PDFDocument.create().then(function (dst) {
            const zeroBased = g.pages.map(function (p) { return p - 1; });
            return dst.copyPages(src, zeroBased).then(function (copied) {
              copied.forEach(function (pg) { dst.addPage(pg); });
              return dst.save();
            }).then(function (out) {
              acc.push({ name: base + "_part" + (gi + 1) + "of" + groups.length + ".pdf",
                         bytes: out, info: g });
              return acc;
            });
          });
        });
      });
      return seq;
    }).then(function (children) {
      const made = [];
      children.forEach(function (c) {
        const existing = parent.getFilesByName(c.name);
        const child = existing.hasNext() ? existing.next()
          : parent.createFile(Utilities.newBlob(c.bytes, "application/pdf", c.name));
        try { child.setDescription(JSON.stringify({ splitFrom: file.getId() })); } catch (e) {}
        made.push(c.name);
      });
      try { file.setDescription(JSON.stringify({ split: true, parts: made, at: todayStr() })); } catch (e) {}
      // NOTE: this is the one place that deliberately moves BEFORE it emails — the opposite
      // of parkWithAlert_. Moving the original out of the scan is what makes the split
      // one-shot. Leave it in intake and a failed report email means the next pass re-runs
      // the whole split: the AI regroups the pages from scratch (child names encode the
      // group index and count, so a different grouping is a different name) and the
      // "does this child already exist?" check only looks in the CURRENT parent, which the
      // first batch of children has already left by being archived. The replay would create
      // a second set of child PDFs and book the expenses twice. Losing a spot-check notice
      // is the smaller harm: the children were created and DO process normally, so no
      // receipt is lost — only the "please verify these amounts" email is.
      file.moveTo(getOrCreateFolder(archive, SPLIT_ORIGINALS_NAME));
      const lines = children.map(function (c, i) {
        const g = c.info;
        return "  " + (i + 1) + ". " + (g.vendor || "?") + " — $" + (g.total_amount || "?") +
               " — " + (g.date || "no date") + " (page" + (g.pages.length > 1 ? "s " : " ") + g.pages.join(",") + ")";
      });
      MailApp.sendEmail(ALERT_EMAIL,
        "Receipt bot auto-split a multi-receipt scan — " + originalName,
        '"' + originalName + '" (' + ctx.projectName + ") contained " + children.length +
        " separate receipts/checks, so it was split automatically:\n\n" + lines.join("\n") +
        '\n\nEach piece is now in "' + parent.getName() + '" and will be read, sent to QuickBooks, and archived ' +
        "individually on the next pass — PLEASE SPOT-CHECK these amounts against the bookings.\n" +
        'The original scan was archived to "' + SPLIT_ORIGINALS_NAME + '" (nothing was deleted).');
      Logger.log(" > [AUTO-SPLIT] " + originalName + " -> " + made.length + " piece(s); original archived to " + SPLIT_ORIGINALS_NAME);
    }).catch(function (e) {
      // Async failure AFTER the sync point of no return: do the park + email here.
      Logger.log(" > [AUTO-SPLIT FAILED] " + originalName + ": " + e.toString());
      // Move-then-alert, same one-shot reasoning as the success path above: a failure here
      // can already have written some children, so leaving the original in intake would let
      // the next pass re-split and duplicate them. This path is therefore NOT converted to
      // parkWithAlert_ — it cannot be, safely, until the split itself is made atomic. That
      // leaves the v3.4 hole open here alone: if this alert throws, the source sits in
      // "_Needs Review" with nobody told. See the auto-split caveat in the header.
      try {
        file.moveTo(getOrCreateFolder(DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID), NEEDS_REVIEW_NAME));
        MailApp.sendEmail(ALERT_EMAIL,
          "Receipt bot: auto-split failed — " + originalName,
          '"' + originalName + '" (' + ctx.projectName + ") contains multiple receipts but could not be auto-split:\n" +
          e.toString() + "\n\n" +
          "Please split it manually into one file per receipt and drop each into the right project folder.\n" +
          'The file was moved to "' + NEEDS_REVIEW_NAME + '".');
      } catch (e2) { Logger.log(" > [AUTO-SPLIT FALLBACK ERROR] " + e2.toString()); }
    });
    return true; // attempt is queued; the chain above resolves success/failure
  } catch (e) {
    Logger.log(" > [AUTO-SPLIT ERROR] " + originalName + ": " + e.toString());
    return false;
  }
}

// Gemini pass for multi-docs: group pages by transaction. Returns
// { transactions: [ { pages: [1,2], vendor, date, invoice, total_amount }, ... ] }
// or null. Two tries per model, then the next model (same busy-model policy as the
// main read; this is a heavier prompt, so no long backoff ladder).
function analyzeMultiPageMapWithGemini(file) {
  const promptText =
    "This PDF contains MULTIPLE separate receipts, invoices, or handwritten checks scanned together.\n" +
    "Group the pages by transaction: a multi-page single receipt stays in ONE group; different vendors\n" +
    "or separate transactions each get their own group. EVERY page of the document must appear in\n" +
    "exactly one group. For each group also read the vendor, date, invoice/check number, and total.\n" +
    "OUTPUT FORMAT (Strict JSON):\n" +
    '{ "transactions": [ { "pages": [1], "vendor": "String", "date": "YYYY-MM-DD or empty",\n' +
    '  "invoice": "String (or NoInv)", "total_amount": "0.00" } ] }';
  const payload = {
    "contents": [{ "parts": [ { "text": promptText },
      { "inline_data": { "mime_type": "application/pdf", "data": Utilities.base64Encode(file.getBlob().getBytes()) } } ] }],
    "generationConfig": { "responseMimeType": "application/json" }
  };
  const options = { "method": "post", "contentType": "application/json",
    "payload": JSON.stringify(payload), "muteHttpExceptions": true };
  for (let mi = 0; mi < GEMINI_MODELS.length; mi++) {
    const model = GEMINI_MODELS[mi];
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + geminiApiKey_();
    for (let a = 0; a < 2; a++) {
      try {
        const res = UrlFetchApp.fetch(url, options);
        const code = res.getResponseCode();
        if (code === 200) {
          const json = JSON.parse(res.getContentText());
          const cand = json && json.candidates && json.candidates[0];
          const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
          const text = part && part.text;
          if (text) { try { return JSON.parse(text); } catch (pe) { break; } }
          break; // empty / safety-blocked -> next model
        }
        if (code === 429 || code === 503) { Utilities.sleep(Math.pow(2, a + 1) * 1000); continue; }
        if (code === 404) break; // model id not on this key -> next model
        // 401/403 = auth/project blocked. SERVICE failure, not this document's
        // fault - fall through to the next model, exactly like the main
        // classifier. (Kimi SHOULD-FIX: this path still treated 403 as fatal, so
        // during the billing outage a multi-page PDF would have been parked as
        // unsplittable while single-page reads were correctly retried. Two
        // classifiers disagreeing about one HTTP code is how the original bug
        // survived review.)
        if (code === 401 || code === 403) break;
        return null;             // 400 (oversized/undecodable payload) -> fatal
      } catch (e) { Utilities.sleep(2000); }
    }
    Logger.log(" > [SPLIT-MAP] " + model + " unavailable; trying next model.");
  }
  Logger.log(" > [SPLIT-MAP] all models failed — cannot auto-split this pass.");
  return null;
}

// pdf-lib has no GAS-native equivalent, so the pinned UMD build is loaded once per
// execution (cached for the run). The UMD wrapper attaches to globalThis.PDFLib.
var PDF_LIB_CACHE_ = null;
function loadPdfLib_() {
  if (PDF_LIB_CACHE_) return PDF_LIB_CACHE_;
  const res = UrlFetchApp.fetch(PDF_LIB_URL, { "muteHttpExceptions": true });
  if (res.getResponseCode() !== 200) throw new Error("pdf-lib download failed (HTTP " + res.getResponseCode() + ")");
  eval(res.getContentText());
  PDF_LIB_CACHE_ = globalThis.PDFLib;
  if (!PDF_LIB_CACHE_) throw new Error("pdf-lib loaded but PDFLib global is missing");
  return PDF_LIB_CACHE_;
}

// --- STANDARD HELPERS ---

/**
 * Readable text -> a PDF blob. Used for e-receipts that arrive as an email BODY with no
 * attachment (Lowe's inline-HTML receipts): the QBO inbox accepts only PDF/JPG/PNG, so
 * the text has to be rendered rather than sent as a .txt.
 *
 * Two details are load-bearing:
 *   - <meta charset="utf-8"> — without it the UTF-8 bytes render as mojibake ("Loweâ€™s").
 *   - <pre> + pre-wrap — keeps the receipt's line-item alignment while still wrapping long
 *     lines instead of running off the right edge of the page.
 */
function textToPdfBlob_(text, pdfName) {
  // Strip only a LETTERS-ONLY extension. These filenames end in the amount
  // ("..._$138.81"), so a generic /\.[^.]*$/ would eat ".81" off an extension-less name
  // and produce "..._$138.pdf" — a silently wrong total on the receipt Marge files.
  const name = String(pdfName || "receipt.pdf").replace(/\.[A-Za-z]{2,5}$/, "") + ".pdf";
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    '<pre style="font-family:Consolas,\'Courier New\',monospace;font-size:11px;' +
    'white-space:pre-wrap;word-wrap:break-word;margin:24px">' +
    escapeHtml_(text) + "</pre></body></html>";
  return Utilities.newBlob(html, "text/html", name.replace(/\.pdf$/i, ".html"))
    .getAs("application/pdf").setName(name);
}

// Ampersand FIRST, or the "&" in the entities we just wrote gets escaped a second time.
function escapeHtml_(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ensureShopCategories(shopFolder) {
  SHOP_CATEGORIES.forEach(function (name) { getOrCreateFolder(shopFolder, name); });
}

function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function sanitize(str) {
  if (!str) return "";
  return str.toString().replace(/[^\w\s\-\.]/gi, '').replace(/\s+/g, '_').trim();
}

// "14 L&I Insurance" -> "L&I Insurance" (number prefix is only for Drive sorting)
function displayCategory(cat) {
  // Strip the "NN " sort prefix AND any " (1)" duplicate suffix Google Drive
  // appends during folder churn — the result must equal the QBO account name
  // exactly or the API push falls back to the email path.
  return String(cat || "").replace(/^\d+[\s\-\.]+/, "").replace(/\s+\(\d+\)\s*$/, "");
}

// Pull a clean YYYY-MM-DD out of the AI's date string: trims whitespace and accepts
// an ISO timestamp ("2026-06-10T00:00:00Z") by taking the leading date portion.
// Returns "" if there's no leading date.
function normalizeDateStr(s) {
  const m = String(s || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// Real calendar-date check (rejects 2026-13-05, 2026-02-30, etc.)
function isValidDate(s) {
  s = String(s || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split("-");
  const y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// Date the file was UPLOADED to Drive — the fallback when the document date can't be read.
function driveDateStr(file) {
  return Utilities.formatDate(file.getDateCreated(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// Handles "$1,234.56", "-12.50" and accounting negatives "(123.45)"
function cleanMoney(v) {
  let s = String(v === undefined || v === null ? "" : v).trim();
  const paren = /^\(.*\)$/.test(s);
  s = s.replace(/[^0-9.\-]/g, "");
  let n = parseFloat(s);
  if (isNaN(n) || !isFinite(n)) return "0.00";
  if (paren && n > 0) n = -n;
  return n.toFixed(2);
}

// File extension from the original name (known types only), else from MIME type
function getExtension(originalName, mimeType) {
  const KNOWN = ["pdf","jpg","jpeg","png","heic","heif","webp","gif","txt","tif","tiff","bmp"];
  const parts = String(originalName || "").split(".");
  if (parts.length > 1) {
    const ext = parts.pop().toLowerCase();
    if (KNOWN.indexOf(ext) !== -1) return "." + ext;
  }
  const map = {
    "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png",
    "image/heic": ".heic", "image/heif": ".heic", "image/webp": ".webp",
    "image/gif": ".gif", "text/plain": ".txt"
  };
  return map[String(mimeType || "").toLowerCase()] || ".pdf";
}

// --- CONTENT DEDUP ---
// date|invoice(or check#) — the invoice/check number is unique per purchase, so date + ref
// is already a safe identity on its own (and this key is only built when BOTH were read off
// the document). The VENDOR used to lead this key and had to come out: the AI reads the same
// store's name differently across that store's own formats — "Lowe's Home Improvement" on
// the purchase-receipt mail vs "Lowe's" on the PO# sales receipt for ONE in-store sale,
// "Richard Lord" vs "Columbia Resources" on one handwritten check — and each drift put one
// purchase on two keys, so neither copy was quarantined and BOTH were forwarded to QBO.
// The AMOUNT stays out of the key, for the original reason: if one copy's total is misread,
// both copies must still land here and collapse. It IS recorded alongside the claim, so the
// two ways a collision can be ambiguous — a misread total, or (now that vendor is gone) two
// unrelated vendors reusing an invoice number on one day — go to a human instead of being
// resolved on a guess. See the claim handling in processSingleFile step 4.
function makeDedupKey(date, ref) {
  return [String(date || ""), String(ref || "").toLowerCase()].join("|");
}

// Does this look like a real invoice/check number, rather than the AI's way of saying it
// couldn't find one? Load-bearing since v3.6: the vendor no longer separates the namespaces,
// so a placeholder would make "2026-07-21|na" the SHARED key of every unrelated receipt that
// day and silently quarantine real expenses against each other. Rejecting here is only a
// DOWNGRADE, never a loss — the document still goes through the weak vendor/date/amount net,
// which asks a human instead of deciding on its own. So this leans strict on purpose: a
// short or all-letter ref ("12", "ABC") is refused too, because those collide far too easily
// to be trusted as an identity, and a real one that gets refused merely gets reviewed.
//
// Four ways a value fails, judged on letters and digits alone (sanitize() has already
// dropped punctuation, so "N/A" arrives as "NA" and "4178-8" reduces to "41788"):
//   too short  •  no digits at all  •  its LETTERS spell a stand-in, which is what catches
//   the padded forms like "N/A 000" and "Unknown 0000"  •  its DIGITS are all one character
//   ("0000", "1111"), which is what a faded, unreadable number tends to produce.
// The letter list holds only true no-value words: "INV"/"ORDER"/"REF" are deliberately NOT
// here, because those legitimately prefix real numbers ("INV-95870" must stay authoritative).
const REF_PLACEHOLDERS = ["na", "none", "null", "nil", "no", "noinv", "noinvoice", "nonum",
                          "unknown", "unk", "blank", "notavailable", "nodata", "notfound",
                          "tbd", "missing", "pending", "illegible", "unreadable"];
function refLooksReal_(ref) {
  const r = String(ref || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (r.length < 3) return false;                        // too short to identify anything
  const digits = r.replace(/[^0-9]/g, "");
  if (!digits) return false;                             // every real invoice/check # has digits
  const letters = r.replace(/[^a-z]/g, "");
  if (letters && REF_PLACEHOLDERS.indexOf(letters) > -1) return false;
  return !/^(.)\1*$/.test(digits);                       // "0000" identifies nothing
}

// Second net: canonical vendor|date|amount. Catches what the key above structurally cannot —
// the AI also reads the REF inconsistently between a vendor's formats (the same Lowe's
// purchase arriving once as order # 201632205261901943 and once as invoice # 160992), which
// lands one purchase on two different authoritative keys. This runs for EVERY document, not
// just ref-less ones. A hit is only a POSSIBLE duplicate — two genuine same-day purchases
// from one vendor for the same amount do happen — so it always routes to human review.
// Inputs are already sanitized/normalized by processSingleFile.
function makeWeakDedupKey(vendor, date, amount) {
  return [canonicalVendor(vendor), String(date || ""), String(amount || ""), "amt"].join("|");
}

// One vendor -> one token. Case, punctuation, store numbers and legal suffixes all vary
// between a chain's formats ("LOWES", "Lowe's Home Improvement", "Lowes Home Centers LLC
// S1632MC3"), and the weak key is only useful if they reduce to the same thing. A substring
// hit wins, so an unlucky entry can over-collapse two real vendors ("Palace Hardware" would
// match "acehardware"). That is deliberately tolerable: this token feeds ONLY the weak key,
// whose worst outcome is a review email asking a human — never a silent quarantine. Add a
// brand here whenever a new spelling shows up as a missed duplicate.
const VENDOR_ALIASES = [
  "lowes", "homedepot", "amazon", "costco", "walmart", "safeway", "fredmeyer",
  "officedepot", "acehardware", "harborfreight", "sherwinwilliams", "dutch",
  "usmarket", "spaceage", "irongate", "sunbelt", "valvoline", "rtastore",
  "unitedbuilding", "parrlumber", "lesschwab", "jiffylube"
];
function canonicalVendor(vendor) {
  const v = String(vendor || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < VENDOR_ALIASES.length; i++) {
    if (v.indexOf(VENDOR_ALIASES[i]) > -1) return VENDOR_ALIASES[i];
  }
  return v;
}

// Short, safe Script-Property key for a content key.
function dedupPropKey(key) {
  return "dup_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key));
}

// Claim a content key for this file, recording the total that was read with it. A DIFFERENT
// file with the same key is a duplicate -> returns the owner as { fileId, amount }. The same
// file re-running is NOT a duplicate -> returns null. Read-check-write runs inside a script
// lock so two overlapping trigger runs can't both observe "no owner".
function claimDedupKey(pk, thisFileId, amount) {
  const lock = RECEIPT_RUN_LOCK_HELD_ ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const existing = props.getProperty(pk);
    const owner = parseClaim_(existing);
    if (owner && owner.fileId !== thisFileId) return owner;
    if (!existing) props.setProperty(pk, thisFileId + "|" + String(amount || ""));
    return null;
  } finally { if (lock) lock.releaseLock(); }
}

// Claims written before v3.6 are a bare file id. Those come back with amount "", which
// callers must read as "can't confirm the totals match" rather than as a match. Drive file
// ids are [A-Za-z0-9_-] only, so "|" can never appear in the id half and a present amount is
// always one this script wrote.
function parseClaim_(value) {
  if (!value) return null;
  const parts = String(value).split("|");
  return { fileId: parts[0], amount: parts.length > 1 ? parts[1] : "" };
}

// Release a claim (only if THIS file still owns it) — used when a file gives up
// unbooked, so a later true copy isn't quarantined against a purchase that never booked.
function releaseDedupKey(pk, thisFileId) {
  if (!pk) return;
  const lock = RECEIPT_RUN_LOCK_HELD_ ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const owner = parseClaim_(props.getProperty(pk));
    if (owner && owner.fileId === thisFileId) props.deleteProperty(pk);
  } finally { if (lock) lock.releaseLock(); }
}

// A file can hold BOTH claims now (authoritative and weak), and every path that walks away
// from an unbooked file has to drop both — a claim left behind by a file that can no longer
// book would quarantine the next genuine copy of that purchase, so neither would ever book.
// A failed release is logged rather than thrown: the caller is already on its way to alert a
// human, and blocking that on a transient Properties error would strand the receipt instead.
function releaseDedupClaims_(state, thisFileId) {
  [state.dedupPk, state.dedupWeakPk].forEach(function (pk) {
    if (!pk) return;
    try { releaseDedupKey(pk, thisFileId); }
    catch (relErr) { Logger.log(" > [WARN] dedup release failed (key may linger): " + relErr); }
  });
}

// --- PER-FILE STATE (stored in the Drive file description) ---
function getState(file) {
  try { return JSON.parse(file.getDescription() || "{}") || {}; }
  catch (e) { return {}; }
}

function setState(file, state) {
  file.setDescription(JSON.stringify(state));
}

// Keep the saved extraction small enough for the description field. The lean
// payload has no line items, so this just guards against a runaway field; returns
// null only if it somehow still doesn't fit (caller then re-runs the AI on resume).
function trimForState(aiData) {
  const MAX_LEN = 3500;
  let copy = JSON.parse(JSON.stringify(aiData));
  ["doc_type","vendor","date","invoice","check_number","memo","total_amount","tax_amount"].forEach(function (k) {
    if (typeof copy[k] === "string" && copy[k].length > 200) copy[k] = copy[k].slice(0, 200);
  });
  return JSON.stringify(copy).length <= MAX_LEN ? copy : null;
}
