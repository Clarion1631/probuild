/**
 * PROBUILD QBO-PURCHASE STEP — drop-in file for the "QBO Automation" Apps
 * Script project. This REPLACES the email-to-QBO path (sendToQBO.gs, which
 * emails the receipt image to golden_touch_remodeling_llc+expenses@assist
 * .intuit.com and lets Intuit's own AI parse/finalize it) once
 * QBO_RECEIPT_PUSH_ENABLED=true is set in ProBuild's Vercel env.
 *
 * What it does: POSTs the SAME doc info object sendToProBuild.gs already
 * builds (categoryGroups etc.) to ProBuild's
 * /api/integrations/qbo-receipts/create endpoint. ProBuild resolves the
 * project -> QBO customer, creates ONE finalized QBO Purchase job-coded at
 * the line level (Vendor/Bank account/customer already set — no bookkeeper
 * triage needed), and best-effort attaches the receipt image/PDF. QBO is
 * still the source of record; ProBuild is just doing the same data entry a
 * human would.
 *
 * IMPORTANT — this does not remove the old email-to-QBO path. Call this
 * function FIRST; only skip/disable sendToQBO's email step once this has
 * been ok:true in production for a while. Until then, keep BOTH wired:
 *   - ok:true  -> mark state.qboApi = purchaseId and skip the legacy email
 *                 (no duplicate Purchase — the email path would create a
 *                 second, unlinked transaction in QBO for the same receipt).
 *   - ok:false -> log + park with an alert, mirroring sendToProBuild's
 *                 conventions, and let the EXISTING sendToQBO email path run
 *                 as the fallback so the receipt still lands in the books.
 *
 * Robustness, same philosophy as sendToProBuild.gs:
 *  - state.qboApi guards re-sends (file description JSON) — a truthy value
 *    (the purchase id) means "already handled, do nothing".
 *  - HTTP != 200 is treated as retryable (throw) — the file stays in place
 *    and the next automation pass retries. ProBuild's own idempotency
 *    (DocNumber = Drive fileId) makes a retry safe even if the first attempt
 *    actually succeeded before the response was lost.
 *  - ok:false is TERMINAL, not retryable (a name-mismatch or a bad amount
 *    split won't fix itself on a retry) — alert a human and fall back to the
 *    legacy email-to-QBO path so the money still gets recorded.
 *  - Files over 7MB skip the base64 attachment (ProBuild's own 8MB decoded
 *    cap plus base64's ~33% overhead) — the Purchase still gets created,
 *    just without an inline attachment; ProBuild logs "skipped" in that case.
 */

const PROBUILD_QBO_PUSH_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-receipts/create";
const MAX_QBO_PUSH_ATTACHMENT_BYTES = 7 * 1024 * 1024; // stay under ProBuild's 8MB decoded cap after base64 overhead

/**
 * @param {GoogleAppsScript.Drive.File} file
 * @param {object} ctx - same automation context sendToProBuild uses (ctx.projectName, ctx.isShop)
 * @param {object} aiData - Gemini/Claude-parsed doc fields (aiData.vendor, aiData.check_number, ...)
 * @param {boolean} isCheck
 * @param {object} categoryGroups - same shape sendExpensesToProBuild builds Line groups from
 * @param {number} totalAmount
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} cleanInv
 * @param {string} memo
 * @param {object} state - the file's persisted automation state (read/written via getState/setState)
 */
function sendReceiptToQuickBooksViaAPI(file, ctx, aiData, isCheck, categoryGroups, totalAmount, dateStr, cleanInv, memo, state) {
  if (state.qboApi) return; // already pushed on a previous pass

  // Shop/overhead expenses have no ProBuild project to code the line to.
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
    checkNumber: aiData.check_number || "",
    memo: memo || "",
    totalAmount: Number(totalAmount),
    fileId: file.getId(),
    fileName: file.getName(),
    groups: groups
  };

  // Attach the receipt image/PDF inline as base64 when it's small enough —
  // ProBuild uses this to attach the file to the QBO Purchase directly.
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
  if (code !== 200) {
    // ProBuild unreachable / server error -> retry on the next pass. The old
    // email-to-QBO path has NOT run yet, so nothing is duplicated by retrying.
    throw new Error("ProBuild QBO push HTTP " + code + ": " + res.getContentText().slice(0, 300));
  }

  const body = JSON.parse(res.getContentText());
  if (body.ok) {
    state.qboApi = body.qbPurchaseId;
    setState(file, state);
    Logger.log("   >> QuickBooks (via ProBuild API): " +
      (body.alreadyExists ? "already pushed, purchase " + body.qbPurchaseId
        : "purchase " + body.qbPurchaseId + " created (attachment: " + (body.attachment || "n/a") + ")"));
    // Do NOT also run the legacy sendToQBO email step for this file — that
    // would create a second, unlinked Purchase for the same receipt.
  } else {
    // Not retryable (project name doesn't match, amount split doesn't add up,
    // push disabled, QuickBooks not connected, ...). Fall back to the legacy
    // email-to-QBO path so the receipt still gets recorded, and alert a human.
    state.qboApi = "failed:" + (body.reason || "unknown");
    setState(file, state);
    MailApp.sendEmail(ALERT_EMAIL,
      "QuickBooks API push needs attention: " + file.getName(),
      'ProBuild did not accept "' + file.getName() + '" for the direct QuickBooks push.\n' +
      "Reason: " + (body.reason || "unknown") + "\n" +
      "Drive folder: " + ctx.projectName + "\n" +
      "Falling back to the email-to-QuickBooks path for this file — it will still be recorded, " +
      "just without job-level coding until this is fixed.\n" +
      (body.reason === "project-not-matched"
        ? "Fix: rename the Drive folder to match the ProBuild project name (or create the project in ProBuild)."
        : body.reason === "amount-mismatch"
          ? "Fix: the category split totals don't add up to the document total — check the AI parse for this receipt."
          : body.reason === "push-disabled"
            ? "QBO_RECEIPT_PUSH_ENABLED is not \"true\" in ProBuild's env — this is expected until the feature is turned on."
            : body.reason === "quickbooks-not-connected"
              ? "Reconnect QuickBooks in ProBuild Settings -> Integrations."
              : "See ProBuild logs for details."));
    // state.qboApi is now a "failed:..." string (truthy), so this function
    // won't retry — but it is NOT a call to sendToQBO here. The caller
    // (runReceiptAutomation.gs) must still invoke the existing sendToQBO
    // email step whenever state.qboApi is not a real purchase id.
  }
}
