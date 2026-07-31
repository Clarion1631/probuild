/**
 * QUICKBOOKS PUSH VIA PROBUILD API — replaces the email-to-QBO send for
 * project receipts. ProBuild creates the finalized QBO Purchase directly:
 * Washington Trust bank account, vendor ensured, expense line coded to the
 * job's QBO customer, receipt file attached — so the bank feed row arrives
 * match-ready and Marge reviews instead of typing.
 *
 * Fallback contract (nothing can be lost):
 *  - HTTP 401            -> loud misconfig alert + throw (file retries next pass)
 *  - other non-200       -> throw (transient; file retries next pass)
 *  - 200 { ok:false }    -> terminal for the API path: the legacy sendToQBO(...)
 *                           EMAIL path runs right here instead, exactly as today
 *  - 200 { ok:true }     -> state.qboApi = the QBO purchase id
 * Shop/overhead docs always take the legacy email path (no ProBuild project).
 *
 * The legacy sendToQBO(...) function stays in runReceiptAutomation as-is; only
 * the step-5 call site changes to call this function.
 *
 * NOTE: the current Gemini extraction has no line-item/category splitting, so
 * the Purchase carries ONE line for the receipt total. When extraction gains
 * category groups, build them here and the ProBuild endpoint already accepts
 * multiple lines that reconcile to the total.
 */

const PROBUILD_QBO_PUSH_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-receipts/create";
// Vercel's request body limit is 4.5MB and base64 inflates raw bytes by ~4/3,
// so the RAW file is capped at 3MB (~4MB encoded) to stay well under it.
const MAX_QBO_PUSH_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function sendReceiptToQuickBooksViaAPI(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment, state) {
  if (state.qboApi) return; // already handled on a previous pass

  // Shop/overhead expenses have no ProBuild project to code the line to, so
  // they stay on the legacy email path — called HERE, not skipped, because
  // nothing else emails them once this function owns the step-5 call site.
  if (ctx.isShop) {
    sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment);
    state.qboApi = "email-shop";
    setState(file, state);
    return;
  }

  const ingestKey = PropertiesService.getScriptProperties().getProperty("RECEIPT_INGEST_SECRET");
  if (!ingestKey) {
    // No key configured -> the API path simply isn't set up yet. Book via the
    // legacy email path so receipt processing NEVER stalls on configuration.
    Logger.log("   >> RECEIPT_INGEST_SECRET not set in Script Properties — using email path.");
    sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment);
    state.qboApi = "email-fallback:no-ingest-key";
    setState(file, state);
    return;
  }

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
    // Single line for the whole receipt — reconciles with totalAmount exactly.
    groups: [{
      category: isCheck ? ("Check #" + (checkNum || "?")) : "Receipt",
      amount: Number(Number(totalAmount).toFixed(2)),
      lines: []
    }]
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
    // Deployment problem, not a per-file problem. Alert loudly AND throw:
    // the file retries automatically once the key is fixed, and no receipt
    // has been lost (neither the API push nor the email fallback have run).
    MailApp.sendEmail(ALERT_EMAIL,
      "QuickBooks API push misconfigured (401 unauthorized)",
      'ProBuild rejected the request for "' + file.getName() + '" as unauthorized.\n' +
      "Check that Script Properties' RECEIPT_INGEST_SECRET matches ProBuild's env var.\n" +
      "No receipt has been lost — this file will retry automatically once the key is fixed.");
    throw new Error("ProBuild QBO push HTTP 401 (unauthorized) — check RECEIPT_INGEST_SECRET.");
  }

  if (code !== 200) {
    // ProBuild unreachable / transient server error -> retry next pass.
    throw new Error("ProBuild QBO push HTTP " + code + ": " + res.getContentText().slice(0, 300));
  }

  const body = JSON.parse(res.getContentText());

  if (body.ok) {
    // Persist success BEFORE logging so nothing can strand a re-sendable state.
    state.qboApi = body.qbPurchaseId;
    setState(file, state);
    Logger.log("   >> QuickBooks (via ProBuild API): " +
      (body.alreadyExists ? "already pushed, purchase " + body.qbPurchaseId
        : "purchase " + body.qbPurchaseId + " created (attachment: " + (body.attachment || "n/a") + ")"));
    return;
  }

  // Terminal for the API path (push-disabled, project-not-matched,
  // missing-vendor, amount-mismatch, qbo-fault, ...): book via the legacy
  // EMAIL path right now, exactly as the automation does today. Only after
  // the fallback returns without throwing is this file marked handled.
  Logger.log("   >> QuickBooks API push declined (" + body.reason + ") — falling back to email path.");
  sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment);
  state.qboApi = "email-fallback:" + body.reason;
  setState(file, state);
}
