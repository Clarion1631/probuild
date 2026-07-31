/**
 * PROBUILD QBO-PURCHASE STEP — drop-in REPLACEMENT for step 5 ("EMAIL TO
 * QUICKBOOKS" — the sendToQBO(...) call) in runReceiptAutomation.gs, once
 * QBO_RECEIPT_PUSH_ENABLED=true is set in ProBuild's Vercel env.
 *
 * What it does: POSTs the same doc info the automation already parsed to
 * ProBuild's /api/integrations/qbo-receipts/create endpoint. ProBuild
 * resolves the EXACT-matching project -> its own QBO customer (named after
 * the job), creates ONE finalized QBO Purchase job-coded at the line level
 * (vendor/bank account/customer already set — no bookkeeper triage needed),
 * and best-effort attaches the receipt image/PDF. QBO is still the source of
 * record; ProBuild is just doing the same data entry a human would, and every
 * validation on the ProBuild side is terminal-on-doubt rather than a guess —
 * see the reason codes handled in the alert email below.
 *
 * sendToQBO's real signature (runReceiptAutomation.gs:898), mirrored exactly
 * for the fallback call below:
 *   sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo,
 *             checkNum, cleanInv, possibleDuplicate, attachment)
 *
 * Response handling:
 *   - HTTP 401           -> alert loudly (the ingest key is misconfigured —
 *                           a deployment problem, not a per-file problem),
 *                           then throw (retryable; the automation's own
 *                           at-most-once "emailing" guard is untouched here
 *                           since sendToQBO never ran).
 *   - HTTP != 200 and 401 -> throw (retryable: ProBuild unreachable / 5xx).
 *   - HTTP 200, ok:true   -> persist state.qboApi = purchaseId BEFORE any
 *                           logging/alerting, so an exception in those calls
 *                           can never strand this file in a re-sendable state.
 *   - HTTP 200, ok:false  -> TERMINAL for the API push (a name mismatch, a
 *                           missing vendor/date, a bad amount split, or the
 *                           push being disabled won't fix itself on a retry).
 *                           Call the LEGACY sendToQBO(...) email sender
 *                           DIRECTLY as the fallback so the receipt still
 *                           gets recorded. Only AFTER that call returns
 *                           (i.e. does NOT throw) do we persist
 *                           state.qboApi = "email-fallback:<reason>" and
 *                           alert a human to fix the root cause.
 *
 * This does NOT remove the legacy email-to-QBO path — sendToQBO(...) stays
 * in runReceiptAutomation.gs as-is and is the fallback used above. Only the
 * PRIMARY call site (step 5) changes, from calling sendToQBO(...) directly
 * to calling sendReceiptToQuickBooksViaAPI(...) below, which calls
 * sendToQBO(...) itself on ok:false.
 */

const PROBUILD_QBO_PUSH_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-receipts/create";
// Vercel's request body limit is 4.5MB and base64 inflates raw bytes by ~4/3
// (33%), so the RAW file is capped at 3MB (~4MB encoded) to stay well under it.
const MAX_QBO_PUSH_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * @param {GoogleAppsScript.Drive.File} file
 * @param {object} ctx - automation context (ctx.projectName, ctx.isShop)
 * @param {object} aiData - AI-parsed doc fields (aiData.vendor, ...)
 * @param {boolean} isCheck
 * @param {object} categoryGroups - same shape sendExpensesToProBuild builds Line groups from
 * @param {number} totalAmount
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} memo
 * @param {string} checkNum
 * @param {string} cleanInv
 * @param {boolean} possibleDuplicate - passed straight through to sendToQBO's fallback call
 * @param {GoogleAppsScript.Base.Blob} attachment - passed straight through to sendToQBO's fallback call (from qboAttachment_(file))
 * @param {object} state - the file's persisted automation state (read/written via getState/setState)
 */
function sendReceiptToQuickBooksViaAPI(file, ctx, aiData, isCheck, categoryGroups, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment, state) {
  if (state.qboApi) return; // already handled on a previous pass

  // Shop/overhead expenses have no ProBuild project to code the line to —
  // this is the one skip that ISN'T a fallback-to-email case, because the
  // legacy sendToQBO email path handles shop docs exactly the same way today.
  if (ctx.isShop) {
    state.qboApi = "skipped-shop";
    setState(file, state);
    return;
  }

  const ingestKey = PropertiesService.getScriptProperties().getProperty("RECEIPT_INGEST_SECRET");
  if (!ingestKey) {
    throw new Error("RECEIPT_INGEST_SECRET is not set in Script Properties — cannot push to QuickBooks via API.");
  }

  const groups = Object.keys(categoryGroups).map(function (k) {
    const g = categoryGroups[k];
    return {
      category: g.rawCategory || "General",
      amount: Number(g.totalCost.toFixed(2)),
      lines: (g.allDetails || []).slice(0, 10).map(function (d) {
        return { sku: d.sku || "", desc: d.desc || "", price: d.price || "" };
      })
    };
  });

  const payload = {
    projectName: ctx.projectName,
    docType: isCheck ? "check" : "receipt",
    vendor: aiData.vendor || "Unknown",
    date: dateStr,
    invoice: cleanInv,
    checkNumber: checkNum || "",
    memo: memo || "",
    totalAmount: Number(totalAmount),
    fileId: file.getId(),
    fileName: file.getName(),
    groups: groups
  };

  // Attach the receipt image/PDF inline as base64 when it's small enough.
  const blob = file.getBlob();
  if (blob.getBytes().length <= MAX_QBO_PUSH_ATTACHMENT_BYTES) {
    payload.fileBase64 = Utilities.base64Encode(blob.getBytes());
    payload.fileContentType = blob.getContentType();
  }

  const res = UrlFetchApp.fetch(PROBUILD_QBO_PUSH_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "x-ingest-key": ingestKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();

  if (code === 401) {
    // The ingest key ProBuild expects doesn't match Script Properties — a
    // deployment problem, not a per-file problem. Alert loudly AND throw:
    // this file retries automatically once the key is fixed, and no receipt
    // has been lost (neither the API push nor the email fallback have run).
    MailApp.sendEmail(ALERT_EMAIL,
      "QuickBooks API push misconfigured (401 unauthorized)",
      'ProBuild rejected the request for "' + file.getName() + '" as unauthorized.\n' +
      "Check that Script Properties' RECEIPT_INGEST_SECRET matches ProBuild's RECEIPT_INGEST_SECRET env var.\n" +
      "No receipt has been lost — this file will retry automatically once the key is fixed.");
    throw new Error("ProBuild QBO push HTTP 401 (unauthorized) — check RECEIPT_INGEST_SECRET.");
  }

  if (code !== 200) {
    // ProBuild unreachable / server error -> retry on the next pass. Neither
    // the API push nor the email fallback have run yet, so nothing is lost.
    throw new Error("ProBuild QBO push HTTP " + code + ": " + res.getContentText().slice(0, 300));
  }

  const body = JSON.parse(res.getContentText());

  if (body.ok) {
    // Persist success BEFORE any logging below, so an exception in Logger.log
    // (however unlikely) can never strand this file in a re-sendable state
    // and risk a duplicate Purchase attempt on the next pass.
    state.qboApi = body.qbPurchaseId;
    setState(file, state);
    Logger.log("   >> QuickBooks (via ProBuild API): " +
      (body.alreadyExists ? "already pushed, purchase " + body.qbPurchaseId
        : "purchase " + body.qbPurchaseId + " created (attachment: " + (body.attachment || "n/a") + ")"));
    return;
  }

  // ok:false is TERMINAL for the API push — a name mismatch, a missing
  // vendor/date, or a bad amount split won't fix itself on a retry. Fall
  // back to the EXISTING email-to-QuickBooks path so the receipt still gets
  // recorded, mirroring its real signature exactly:
  //   sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo,
  //             checkNum, cleanInv, possibleDuplicate, attachment)
  sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment);

  // Only reached if sendToQBO did NOT throw — i.e. the email fallback
  // actually went out. If it throws, this whole function throws with it and
  // state.qboApi stays unset, so the NEXT pass retries the API push first
  // (safe — it's idempotent by DocNumber/requestid) before falling back again.
  state.qboApi = "email-fallback:" + (body.reason || "unknown");
  setState(file, state);

  MailApp.sendEmail(ALERT_EMAIL,
    "QuickBooks API push needs attention: " + file.getName(),
    'ProBuild did not accept "' + file.getName() + '" for the direct QuickBooks push — sent via the legacy email path instead.\n' +
    "Reason: " + (body.reason || "unknown") + (body.detail ? " (" + body.detail + ")" : "") + "\n" +
    "Drive folder: " + ctx.projectName + "\n" +
    "The receipt IS booked in QuickBooks now (via email), just without job-level coding until this is fixed.\n" +
    (body.reason === "project-not-matched"
      ? "Fix: rename the Drive folder to match the ProBuild project name EXACTLY (case/whitespace aside) — matching is exact now, no fuzzy fallback."
      : body.reason === "missing-vendor"
        ? "Fix: the AI parse found no usable vendor name for this document — check it manually."
        : body.reason === "invalid-date"
          ? "Fix: the AI parse produced no usable, calendar-valid date for this document — check it manually."
          : (body.reason === "amount-mismatch" || body.reason === "invalid-group-amount")
            ? "Fix: the category split totals don't add up to the document total, or a group amount was zero/negative — check the AI parse for this receipt."
            : body.reason === "duplicate-name"
              ? "Fix: QuickBooks already has a vendor with a conflicting name — resolve the duplicate manually in QuickBooks, then re-run."
              : body.reason === "docnumber-conflict"
                ? "Fix: this Drive file id collides with a DIFFERENT existing QuickBooks Purchase — investigate manually before re-running."
                : body.reason === "push-disabled"
                  ? "QBO_RECEIPT_PUSH_ENABLED is not \"true\" in ProBuild's env — expected until the feature is turned on."
                  : body.reason === "quickbooks-not-connected"
                    ? "Reconnect QuickBooks in ProBuild Settings -> Integrations."
                    : body.reason === "qbo-fault"
                      ? "QuickBooks itself rejected the transaction (fault " + (body.detail || "unknown") + ") — see ProBuild logs."
                      : "See ProBuild logs for details."));
}
