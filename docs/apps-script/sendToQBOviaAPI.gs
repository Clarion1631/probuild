/**
 * QUICKBOOKS PUSH VIA PROBUILD API — replaces the email-to-QBO send for
 * project receipts. ProBuild creates the finalized QBO Purchase directly:
 * Washington Trust bank account, vendor ensured, expense line coded to the
 * job's QBO customer, receipt file attached — so the bank feed row arrives
 * match-ready and Marge reviews instead of typing.
 *
 * ROLLOUT FLAG (GAS-side): Script Property QBO_API_PUSH_ENABLED must be
 * exactly "true" or every document takes the legacy email path WITHOUT any
 * HTTP call — while the feature is off, this pipeline has ZERO dependency
 * on ProBuild/Vercel being reachable. Turn the ProBuild env flag and this
 * property on together.
 *
 * STICKY ROUTE (per document): the first routing decision is persisted in
 * state.qboRoute BEFORE any side effect. A document routed "email" never
 * calls the API again (even if flags/config change between passes), and a
 * document routed "api" retries the API idempotently (server-side requestid
 * + DocNumber dedupe) — so a config change mid-retry can never double-book.
 *
 * Fallback contract (nothing can be lost):
 *  - GAS flag off / no key / file > 3MB -> email path (sticky)
 *  - HTTP 401            -> ONE alert per file (quota-guarded), then throw (retry)
 *  - other non-200       -> throw (transient; retries next pass)
 *  - 200 { ok:false }    -> sticky email route, then the legacy sendToQBO(...)
 *  - 200 { ok:true }     -> state.qboApi = the QBO purchase id
 * Shop/overhead docs always take the legacy email path (no ProBuild project).
 *
 * NOTE: the current Gemini extraction has no line-item/category splitting, so
 * the Purchase carries ONE line for the receipt total. When extraction gains
 * category groups, build them here — the ProBuild endpoint already accepts
 * multiple lines that reconcile to the total.
 */

const PROBUILD_QBO_PUSH_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-receipts/create";
// Vercel's request body limit is 4.5MB and base64 inflates raw bytes by ~4/3.
// Larger files route to the EMAIL path (QBO's receipts inbox keeps the file),
// so the receipt image is never silently dropped from the books.
const MAX_QBO_PUSH_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function sendReceiptToQuickBooksViaAPI(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment, state) {
  if (state.qboApi) return; // already handled on a previous pass

  // Books the document via the legacy email send and stamps the sticky
  // outcome — the single funnel for every non-API route below.
  function emailPath(reason) {
    if (state.qboRoute !== "email") {
      // Persist the route BEFORE the side effect: once a document is an
      // email document it can never later become an API document, even if
      // flags flip between passes (kills the rollout double-book window).
      state.qboRoute = "email";
      setState(file, state);
    }
    sendToQBO(file, ctx, aiData, isCheck, totalAmount, dateStr, memo, checkNum, cleanInv, possibleDuplicate, attachment);
    state.qboApi = "email-fallback:" + reason;
    setState(file, state);
  }

  // A document already routed to email NEVER re-attempts the API.
  if (state.qboRoute === "email") return emailPath("sticky-email-route");

  // A document already committed to the API route may have a POST in flight
  // from a crashed pass — its ONLY safe move is retrying the idempotent API
  // call. Flag/size checks must not divert it to email (that could double-
  // book a Purchase the ambiguous earlier POST already created).
  const apiCommitted = state.qboRoute === "api";

  if (!apiCommitted) {
    // Shop/overhead expenses have no ProBuild project to code the line to.
    if (ctx.isShop) return emailPath("shop");

    // GAS-side rollout flag: while off, no HTTP call is made at all — the
    // legacy pipeline keeps zero dependency on ProBuild being reachable.
    const gasFlag = PropertiesService.getScriptProperties().getProperty("QBO_API_PUSH_ENABLED");
    if (gasFlag !== "true") return emailPath("gas-flag-off");
  }

  const ingestKey = PropertiesService.getScriptProperties().getProperty("RECEIPT_INGEST_SECRET");
  if (!ingestKey) {
    if (apiCommitted) {
      // Can't email (ambiguous prior POST) and can't call (no key): retry
      // later — restoring the key resumes this file automatically.
      throw new Error("RECEIPT_INGEST_SECRET missing while this document is API-committed — retrying next pass.");
    }
    return emailPath("no-ingest-key");
  }

  // Use the QBO-READY blob the caller already built (qboAttachment_): for a
  // text/plain source (Lowe's email receipts) that's the PDF CONVERSION, never
  // the raw .txt — QuickBooks must never receive a text file. Files too large
  // to ride the API request keep their attachment by going through the email
  // path instead of creating an attachment-less Purchase.
  const blob = attachment || file.getBlob();
  const blobBytes = blob.getBytes();
  if (!apiCommitted && blobBytes.length > MAX_QBO_PUSH_ATTACHMENT_BYTES) return emailPath("file-too-large");

  // Point of no return for routing: this document is an API document. The
  // POST is idempotent server-side (requestid + DocNumber from the Drive
  // fileId), so any number of retries can only ever yield one Purchase.
  if (!apiCommitted) {
    state.qboRoute = "api";
    setState(file, state);
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
    fileName: blob.getName() || file.getName(),
    // Single line for the whole receipt — reconciles with totalAmount exactly.
    groups: [{
      category: isCheck ? ("Check #" + (checkNum || "?")) : "Receipt",
      amount: Number(Number(totalAmount).toFixed(2)),
      lines: []
    }]
  };
  // Guarded again here so an API-committed retry of an oversize file sends a
  // slim payload (Purchase without inline file) instead of 413-looping.
  if (blobBytes.length <= MAX_QBO_PUSH_ATTACHMENT_BYTES) {
    payload.fileBase64 = Utilities.base64Encode(blobBytes);
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
    // Deployment problem, not a per-file problem. Alert ONCE per file (and
    // only when mail quota exists — the alert must never eat the quota the
    // receipt pipeline itself needs), then throw so the file retries.
    if (!state.qbo401Alerted && MailApp.getRemainingDailyQuota() > 0) {
      state.qbo401Alerted = true;
      setState(file, state); // persist BEFORE sending — an alert crash can't re-alert forever
      MailApp.sendEmail(ALERT_EMAIL,
        "QuickBooks API push misconfigured (401 unauthorized)",
        'ProBuild rejected the request for "' + file.getName() + '" as unauthorized.\n' +
        "Check that Script Properties' RECEIPT_INGEST_SECRET matches ProBuild's env var.\n" +
        "No receipt has been lost — this file will retry automatically once the key is fixed.");
    }
    throw new Error("ProBuild QBO push HTTP 401 (unauthorized) — check RECEIPT_INGEST_SECRET.");
  }

  if (code !== 200) {
    // ProBuild unreachable / transient server error -> retry next pass. The
    // sticky "api" route + server-side idempotency make retries safe.
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

  // Terminal decline (push-disabled, project-not-matched, missing-vendor,
  // amount-mismatch, qbo-fault, ...): this document becomes an email
  // document — route persisted first, then booked via the legacy path.
  Logger.log("   >> QuickBooks API push declined (" + body.reason + ") — falling back to email path.");
  emailPath(body.reason);
}
