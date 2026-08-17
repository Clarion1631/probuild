/**
 * EMAIL -> DRIVE INTAKE  (file "pullReceiptEmails.gs")
 * ===================================================
 * Replaces the old `processLowesReceipts`, which called GmailApp.search() and so
 * only ever saw the mailbox the script RUNS AS (jadkins@) — but vendor receipts
 * arrive in rlord@. That mismatch is why emailed Lowe's receipts never reached
 * Drive.
 *
 * This reads the RIGHT mailbox via the service account + domain-wide delegation
 * (impersonation), finds receipt emails, and drops each one into the SAME "New
 * Receipts & Checks" intake the main automation already watches — so the existing
 * OCR / dedup / QBO / ProBuild / archive pipeline handles it. One spot for
 * everyone: field photos, the mobile app, AND vendor emails all land here.
 *
 * Switch MAILBOX to receipts@ once Lowe's (etc.) is pointed there; the same code
 * works because receipts@ is just another mailbox to impersonate.
 *
 * Add a SECOND time-driven trigger (every 10 min) on `pullReceiptEmails`.
 * SETUP for the domain-wide delegation is in DEPLOY.md.
 *
 * v1.1: typo-tolerant routing — register-typed job codes are often off by a letter
 * or two ("muller", "messplay", "burg"). A PO#/Customer Code within edit distance
 * 1-2 of exactly ONE word in exactly ONE project folder's name now files there
 * instead of parking in _Needs Review. Ambiguous near-matches still park.
 * v1.2: body-only e-receipts are saved as a PDF, not a .txt. QuickBooks' receipt
 * inbox renders only PDF/JPG/PNG — a .txt was accepted by Intuit but could never be
 * shown as a receipt document, so every Lowe's inline-HTML receipt arrived unusable.
 */

// --- CONFIG ---
const MAILBOX            = "rlord@goldentouchremodeling.com"; // -> "receipts@goldentouchremodeling.com" later
const GMAIL_SCOPE        = "https://www.googleapis.com/auth/gmail.modify"; // read + add labels
const EMAIL_PROCESSED_LABEL = "GTR_Receipt_Filed"; // added after we save it, so it's never re-pulled
const EMAIL_LOOKBACK     = "newer_than:30d";

// RECEIPT-only senders — the address that sends the actual itemized SALES RECEIPT.
// Lowe's ALSO emails order confirmations (notifications.lowes.com) and pickup
// confirmations (confirmation.lowes.com); those are NOT receipts and would create
// DUPLICATE expenses for the same purchase (often with a different date, so the
// content dedup can't always collapse them) — so they're deliberately excluded.
// For other vendors, label the real receipt "Receipts" in the mailbox (the query
// below also matches label:Receipts) until that vendor's receipt-only sender
// domain is confirmed, then add it here. Keep this list tight on purpose.
// `since` (Gmail YYYY/MM/DD, optional) floors a sender at its go-live date.
// Without it a newly added sender back-fills the whole EMAIL_LOOKBACK window,
// which would re-file purchases someone already filed by hand and double-book
// them — the Script-Property markers only suppress mail this job pulled before.
const RECEIPT_SENDERS = [
  { from: "receipt.lowes.com" },  // receipt-only sender — pulled by address alone (no subject filter)
  // Amazon's order confirmation is the priced document (shipment and delivery
  // mails carry no totals) and auto-confirm sends ONLY that, one per order.
  // It belongs here rather than under the subject-gated vendor domains below
  // because Amazon's subject is "Ordered: <item>" / "Your Amazon.com order of
  // <item>", which matches none of the transactional terms — so every Amazon
  // receipt was silently skipped. order-update@ / shipment-tracking@ /
  // marketplace-messages@ stay OUT: same order, no prices, would double-book.
  // Floored at go-live because July's Amazon orders were filed by hand.
  { from: "auto-confirm@amazon.com", since: "2026/08/03" }
];

// Vendors that send receipts AND marketing from the same domain — pulled only
// when the SUBJECT looks transactional, so promos don't flood the intake.
// Tune freely: add vendors/terms, and promote any confirmed receipt-only sender
// up into RECEIPT_SENDERS. NOTE: Gmail strips punctuation in subject search, so
// "order #" collapses to the broad word "order" — keep terms as whole words or
// quoted phrases (that's why we use "order confirmation", not "order #").
const RECEIPT_VENDOR_DOMAINS = [
  "amazon.com", "homedepot.com", "bldr.com", "buildersfirstsource.com",
  "thertastore.com", "acehardware.com", "cfmfloors.com"
];
const RECEIPT_SUBJECT_TERMS = [
  "invoice", "receipt", "\"order confirmation\"", "\"tax invoice\""
];

/**
 * TRIGGER TARGET — add a 10-minute time-driven trigger on this function.
 */
function pullReceiptEmails() {
  const token = getMailboxToken(MAILBOX);
  const intake = DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID);

  const labelId = ensureGmailLabel(token, MAILBOX, EMAIL_PROCESSED_LABEL);
  const senderClause  = RECEIPT_SENDERS.map(function (s) {
    return "(from:" + s.from + (s.since ? " after:" + s.since : "") + ")";
  }).join(" OR ");
  const vendorFrom    = RECEIPT_VENDOR_DOMAINS.map(function (s) { return "from:" + s; }).join(" OR ");
  const subjectClause = "subject:(" + RECEIPT_SUBJECT_TERMS.join(" OR ") + ")";
  const vendorClause  = RECEIPT_VENDOR_DOMAINS.length
    ? " OR ((" + vendorFrom + ") " + subjectClause + ")"
    : "";
  // (receipt-only senders) OR (mixed vendors with a transactional subject) OR (manually labeled), minus already-filed.
  const query = "(" + senderClause + vendorClause + " OR label:Receipts) -label:" + EMAIL_PROCESSED_LABEL + " " + EMAIL_LOOKBACK;

  const ids = gmailListMessageIds(token, MAILBOX, query);
  Logger.log("--- EMAIL INTAKE: " + ids.length + " candidate message(s) in " + MAILBOX + " ---");

  // Project folders the main automation routes by (name match against PO#/job).
  const projectFolders = listChildFolders(intake);

  const props = PropertiesService.getScriptProperties();
  ids.forEach(function (id) {
    const seenKey = "email_" + id;
    try {
      // Idempotency: a Script-Property marker (set the moment a save succeeds) is
      // the source of truth, NOT the file in Drive — the main automation renames
      // and archives the saved file, so a filename check would miss it and we'd
      // re-save. If the marker is set, the email was already filed; just make sure
      // it's labeled (covers a prior run that saved but then failed to label).
      if (props.getProperty(seenKey)) {
        gmailAddLabel(token, MAILBOX, id, labelId);
        return;
      }
      const msg = gmailGetMessage(token, MAILBOX, id);
      const saved = saveReceiptToIntake(msg, intake, projectFolders);
      props.setProperty(seenKey, saved.fileName || "saved"); // mark BEFORE labeling
      gmailAddLabel(token, MAILBOX, id, labelId);
      Logger.log("   >> " + (saved.ok ? "Filed to " + saved.folderName : "Parked in _Needs Review") + " [" + saved.fileName + "]");
    } catch (e) {
      Logger.log("   >> [ERROR] message " + id + ": " + e.toString());
      // Do NOT label / mark on hard error -> retried next pass.
    }
  });
}

/**
 * Save one email's receipt into the intake. Prefers a real PDF/image attachment;
 * falls back to the plain-text body (the main automation's Gemini reads text/plain).
 * Routes to the project folder whose name best matches the email's PO#/job; else
 * Shop (overhead); else _Needs Review.
 */
function saveReceiptToIntake(msg, intake, projectFolders) {
  const headers = gmailHeaders(msg);
  const subject = headers["subject"] || "";
  const from = headers["from"] || "";
  const plainBody = gmailPlainBody(msg);

  const jobHint = extractJobHint(subject, plainBody);
  const dest = chooseDestination(jobHint, projectFolders, intake);

  const vendorGuess = guessVendor(from, subject);
  const stamp = (headers["date_iso"] || todayStr());
  const baseName = sanitize(vendorGuess || "Receipt") + "_" + stamp + "_email_" + msg.id;

  const attachments = gmailAttachments(msg); // [{filename, mimeType, attachmentId, size, inline}]
  const receiptAtts = attachments.filter(function (a) {
    const isPdf = /\.pdf$/i.test(a.filename || "") || /application\/pdf/i.test(a.mimeType || "");
    if (isPdf) return true; // PDFs are always real receipts
    const isImg = /^image\//i.test(a.mimeType || "") ||
                  /\.(jpe?g|png|heic|heif|webp|gif|tif?f|bmp)$/i.test(a.filename || "");
    if (!isImg) return false;
    if (a.inline) return false;        // skip inline logos / signatures / banners
    return (a.size || 0) >= 20000;     // skip tiny images (icons, QR codes, spacers)
  });

  // Per-item idempotency: the message-level marker is only set after this whole
  // function returns, so if attachment 2 throws, the retry re-enters here — these
  // per-attachment / per-body markers stop attachment 1 (or the body .txt) from
  // being saved twice.
  const props = PropertiesService.getScriptProperties();
  const itemKey = function (suffix) {
    return "email_" + msg.id + "_" +
      Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, suffix)).slice(0, 16);
  };

  let fileName;
  if (receiptAtts.length > 0) {
    receiptAtts.forEach(function (a, i) {
      const ext = (a.filename && a.filename.indexOf(".") > -1) ? a.filename.slice(a.filename.lastIndexOf(".")) : ".pdf";
      fileName = baseName + (receiptAtts.length > 1 ? "_" + (i + 1) : "") + ext;
      const k = itemKey("att_" + a.attachmentId);
      if (props.getProperty(k)) return; // saved on an earlier pass
      const bytes = gmailAttachmentBytes(msg.id, a.attachmentId);
      dest.folder.createFile(Utilities.newBlob(bytes, a.mimeType || "application/pdf", fileName));
      props.setProperty(k, "1");
    });
  } else {
    // No attachment (e.g. Lowe's inline-HTML receipts) -> render the readable text as a
    // PDF. It must NOT be a .txt: the QBO receipt inbox takes only PDF/JPG/PNG, so a .txt
    // reaches Intuit but can never be displayed as a receipt document.
    const k = itemKey("body");
    if (!props.getProperty(k)) {
      const text = "FROM: " + from + "\nSUBJECT: " + subject + "\n\n" + plainBody;
      // Degrade to .txt rather than lose the receipt. getAs("application/pdf") is a
      // conversion and CAN throw (daily conversion quota). Letting it propagate would send
      // this message back to the retry pool, and once it ages past EMAIL_LOOKBACK it drops
      // out of the query for good — filed nowhere, with nobody told. A .txt still reaches
      // Drive, and sendToQBO renders text/plain to PDF at send time, so the only cost of
      // the fallback is a less tidy artifact in the intake folder.
      try {
        fileName = baseName + ".pdf";
        dest.folder.createFile(textToPdfBlob_(text, fileName));
      } catch (pdfErr) {
        fileName = baseName + ".txt";
        Logger.log("   >> [WARN] PDF render failed, saved as .txt (QBO send will convert it): " + pdfErr);
        dest.folder.createFile(fileName, text, MimeType.PLAIN_TEXT);
      }
      props.setProperty(k, "1");
    } else {
      fileName = baseName + ".pdf"; // already saved on an earlier pass
    }
  }

  return { ok: dest.matched, folderName: dest.folder.getName(), fileName: fileName };
}

/**
 * Pick the destination folder: a project folder matched by job hint > Shop > _Needs Review.
 */
function chooseDestination(jobHint, projectFolders, intake) {
  const hintRaw = (jobHint || "").trim();
  if (hintRaw) {
    const hint = hintRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
    let exact = null, best = null, bestLen = 0;
    // Hints now only come from a literal "PO#" / "Customer Code", so even a short
    // one is a real job reference — 3 chars lets "PO#ADU" reach "Berg ADU".
    if (hint.length >= 3) {
      projectFolders.forEach(function (f) {
        // Only exact "Shop" is overhead; "Shop Shed" remains eligible as a project.
        if (f.name.startsWith("_") || isOverheadShopFolder_(f.name)) return;
        const fn = f.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (fn.length < 4) return; // too short to match safely (avoids "00"/"lisa"-style false hits)
        if (fn === hint) { exact = f; return; } // exact normalized match wins outright
        if (hint.length < 4) {
          // A SHORT hint may only equal a whole WORD of the folder name ("adu" ->
          // "Berg ADU") — never a substring, so "kit" can't hit "Mesplay Kitchen".
          const words = f.name.toLowerCase().split(/[^a-z0-9]+/);
          if (words.indexOf(hint) > -1 && fn.length > bestLen) { best = f; bestLen = fn.length; }
          return;
        }
        // else contain the SHORTER inside the LONGER; prefer the longest (most specific).
        const matched = hint.length >= fn.length ? hint.indexOf(fn) > -1 : fn.indexOf(hint) > -1;
        if (matched && fn.length > bestLen) { best = f; bestLen = fn.length; }
      });
    }
    // Exact match beats a longer containing folder (so "Pine" goes to "Pine", not "Pinecrest").
    const pick = exact || best;
    if (pick) return { folder: pick.folder, matched: true };
    // TYPO-TOLERANT fallback: the job code was typed at a register, so it's often
    // off by a letter or two ("muller", "messplay", "burg"). Accept a near-match
    // only when it's UNAMBIGUOUS — otherwise still park for a human.
    const fuzzy = fuzzyMatchFolder(hint, projectFolders);
    if (fuzzy) {
      Logger.log("   >> [FUZZY] job hint '" + hintRaw + "' ~ '" + fuzzy.name + "' (edit distance match)");
      return { folder: fuzzy.folder, matched: true };
    }
    // A job WAS named but we couldn't confidently place it -> human review,
    // NOT overhead (booking a project receipt as Shop would corrupt job costs).
    return { folder: getOrCreateFolder(intake, NEEDS_REVIEW_NAME), matched: false };
  }
  // No job hint at all -> genuine overhead -> Shop if it exists
  const shop = projectFolders.filter(function (f) { return isOverheadShopFolder_(f.name); })[0];
  if (shop) return { folder: shop.folder, matched: false };
  return { folder: getOrCreateFolder(intake, NEEDS_REVIEW_NAME), matched: false };
}

// Typo-tolerant folder match. Compares the normalized hint against each WORD of
// each project folder's name (plus the squashed full name) and accepts the best
// candidate only when it is the SINGLE folder within the distance budget: <=1
// edit for 4-5 char hints, <=2 for 6+ (longer hints survive more typo damage).
// Same exclusions as exact matching ("_" helpers and Shop). A tie between two
// folders (or no candidate) -> null, and the caller parks for a human instead.
function fuzzyMatchFolder(hint, projectFolders) {
  if (!hint || hint.length < 4) return null;
  const maxDist = hint.length >= 6 ? 2 : 1;
  let winner = null, winnerDist = maxDist + 1, ambiguous = false;
  projectFolders.forEach(function (f) {
    if (f.name.startsWith("_") || isOverheadShopFolder_(f.name)) return;
    let d = editDistance(hint, f.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const words = f.name.toLowerCase().split(/[^a-z0-9]+/);
    words.forEach(function (w) {
      if (w.length >= 3) { const dw = editDistance(hint, w); if (dw < d) d = dw; }
    });
    if (d > maxDist) return;
    if (d < winnerDist) { winner = f; winnerDist = d; ambiguous = false; }
    else if (d === winnerDist) { ambiguous = true; } // two folders equally close -> don't guess
  });
  return (winner && !ambiguous) ? winner : null;
}

// Levenshtein edit distance: min single-character insert/delete/substitute count.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = [], cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

// Lowe's puts "PO #<job>" in the subject ("PO#Mueller - Your Sales Receipt") and
// body ("PO # Mueller"). Pull the first such token as the routing hint.
// The "\b" and the REQUIRED "#" are load-bearing: without them the pattern fired
// on the "po" inside ordinary words ("viewport", "support") in HTML bodies and
// produced a garbage hint, which parked EVERY body-only e-receipt in _Needs Review.
// The capture also stops at a spaced hyphen so "PO#Mueller - Your Sales Receipt"
// yields "Mueller", not the whole subject tail.
function extractJobHint(subject, body) {
  const text = (subject || "") + "\n" + (body || "");
  const m = text.match(/\bPO\s*#\s*[:\-]?\s*([A-Za-z0-9 _\-\.]{2,40})/i);
  if (m) return m[1].split(/\s+-\s+|\s{2,}|\n|\||,/)[0].trim();
  // Lowe's IN-STORE e-receipts have no PO# — the job rides in a "Customer Code
  // <job>" line in the body instead. Same routing meaning, so use it as the
  // fallback hint. BODY only and line-anchored, so prose or a subject like
  // "Customer Code Update" can't become a hint; "[ \t]" (never \s) after the
  // label so an EMPTY Customer Code line can't swallow the newline and capture
  // the next line. (Label + value sit in adjacent <td> cells of one <tr>, which
  // htmlToText renders as one "Customer Code <job>" line — the </tr> newline
  // bounds the capture.)
  const cc = (body || "").match(/(?:^|\n)Customer Code[ \t]*(?:[:\-][ \t]*|[ \t]+)([A-Za-z0-9 _\-\.]{2,40})/i);
  if (cc) return cc[1].split(/\s+-\s+|\s{2,}|\n|\||,/)[0].trim();
  return "";
}

function guessVendor(from, subject) {
  if (/lowes/i.test(from) || /lowe'?s/i.test(subject)) return "Lowes";
  if (/homedepot/i.test(from) || /home depot/i.test(subject)) return "Home_Depot";
  if (/costco/i.test(from)) return "Costco";
  const m = from.match(/@([a-z0-9.\-]+)/i);
  return m ? m[1].split(".")[0] : "Vendor";
}

function listChildFolders(parent) {
  const out = [], it = parent.getFolders();
  while (it.hasNext()) { const f = it.next(); out.push({ name: f.getName(), folder: f }); }
  return out;
}

/* ===================== Gmail via service-account impersonation ===================== */

// OAuth2 access token for the impersonated mailbox (domain-wide delegation).
// Reuses the OAuth2 library already in the project + SERVICE_ACCOUNT_KEY property.
function getMailboxToken(subject) {
  const key = JSON.parse(PropertiesService.getScriptProperties().getProperty("SERVICE_ACCOUNT_KEY"));
  if (!key) throw new Error("SERVICE_ACCOUNT_KEY not set in Script Properties.");
  const service = OAuth2.createService("gmail_" + subject)
    .setTokenUrl(key.token_uri)
    .setPrivateKey(key.private_key)
    .setIssuer(key.client_email)
    .setSubject(subject)               // impersonate this mailbox (requires DWD)
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache())
    .setParam("access_type", "offline")
    .setScope(GMAIL_SCOPE);
  service.reset(); // always mint a fresh impersonated token (cheap, avoids stale-subject reuse)
  if (!service.hasAccess()) {
    throw new Error("Gmail impersonation failed for " + subject + ": " + service.getLastError());
  }
  return service.getAccessToken();
}

function gmailApi(token, method, url, payload) {
  const opts = {
    method: method,
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  };
  if (payload) { opts.contentType = "application/json"; opts.payload = JSON.stringify(payload); }
  const res = UrlFetchApp.fetch(url, opts);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Gmail API " + code + " " + url + " :: " + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText() || "{}");
}

function gmailListMessageIds(token, mailbox, query) {
  const base = "https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(mailbox) + "/messages";
  const ids = [];
  let pageToken = null, guard = 0;
  do {
    const url = base + "?q=" + encodeURIComponent(query) + "&maxResults=100" + (pageToken ? "&pageToken=" + pageToken : "");
    const json = gmailApi(token, "get", url);
    (json.messages || []).forEach(function (m) { ids.push(m.id); });
    pageToken = json.nextPageToken;
  } while (pageToken && ++guard < 60); // up to ~6000 msgs/run
  if (pageToken) {
    // Backlog bigger than one run can hold. We still drain it over successive
    // runs (each pass labels what it files, shrinking the unlabeled set), but
    // surface it so a huge one-time backlog is noticed rather than starving.
    Logger.log("   >> [WARN] message list capped at " + ids.length + "; more remain — continuing next run.");
  }
  return ids;
}

function gmailGetMessage(token, mailbox, id) {
  const url = "https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(mailbox) +
              "/messages/" + id + "?format=full";
  return gmailApi(token, "get", url);
}

function gmailAttachmentBytes(messageId, attachmentId) {
  const token = getMailboxToken(MAILBOX);
  const url = "https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(MAILBOX) +
              "/messages/" + messageId + "/attachments/" + attachmentId;
  const json = gmailApi(token, "get", url);
  return Utilities.base64DecodeWebSafe(json.data);
}

function gmailAddLabel(token, mailbox, id, labelId) {
  const url = "https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(mailbox) +
              "/messages/" + id + "/modify";
  gmailApi(token, "post", url, { addLabelIds: [labelId] });
}

function ensureGmailLabel(token, mailbox, name) {
  const base = "https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(mailbox) + "/labels";
  const list = gmailApi(token, "get", base);
  const found = (list.labels || []).filter(function (l) { return l.name === name; })[0];
  if (found) return found.id;
  const created = gmailApi(token, "post", base, {
    name: name, labelListVisibility: "labelShow", messageListVisibility: "show"
  });
  return created.id;
}

/* ---- message payload helpers (Gmail's nested MIME tree) ---- */

function gmailHeaders(msg) {
  const out = {};
  const hs = (msg.payload && msg.payload.headers) || [];
  hs.forEach(function (h) { out[h.name.toLowerCase()] = h.value; });
  if (out["date"]) {
    const d = new Date(out["date"]);
    if (!isNaN(d.getTime())) out["date_iso"] = Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return out;
}

// Prefer a real text/plain part. If the message only has HTML (Lowe's e-receipts
// are a SINGLE text/html body with no text/plain sibling), convert it to readable
// text — saving the raw HTML made 60-165 KB .txt files whose CSS/markup broke the
// PO-hint routing and fed Gemini mostly noise.
function gmailPlainBody(msg) {
  let plain = "", html = "";
  (function walk(part) {
    if (!part) return;
    if (part.body && part.body.data) {
      const data = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString();
      if (part.mimeType === "text/plain") plain += data + "\n";
      else if (part.mimeType === "text/html") html += data + "\n";
    }
    (part.parts || []).forEach(walk);
  })(msg.payload);
  if (!plain && !html && msg.payload && msg.payload.body && msg.payload.body.data) {
    // single-part message with an unexpected mime type — take it as-is
    plain = Utilities.newBlob(Utilities.base64DecodeWebSafe(msg.payload.body.data)).getDataAsString();
  }
  // trim(): an empty text/plain part still appends "\n", which must not shadow a real HTML body
  return plain.trim() ? plain : htmlToText(html);
}

// Raw HTML -> readable text: drop style/script/head blocks and comments, turn
// block-level closers into newlines, strip the remaining tags, decode the few
// entities receipts actually use, and collapse the whitespace the markup leaves.
function htmlToText(html) {
  let s = String(html || "");
  if (!s) return "";
  s = s.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
       .replace(/&#x([0-9a-f]+);/gi, function (m0, h) { return String.fromCharCode(parseInt(h, 16)); })
       .replace(/&#(\d+);/g, function (m0, d) { return String.fromCharCode(parseInt(d, 10)); })
       .replace(/&amp;/gi, "&"); // ampersand LAST so "&amp;lt;" ends as "&lt;", not "<"
  // NBSP: a numeric &#160; decodes to NBSP, which must collapse to a plain space or
  // it defeats the "[ \t]" separators in the Customer Code matcher.
  s = s.replace(/[ \t\u00A0]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n");
  return s.trim();
}

function gmailAttachments(msg) {
  const out = [];
  (function walk(part) {
    if (!part) return;
    if (part.filename && part.body && part.body.attachmentId) {
      const hdrs = {};
      (part.headers || []).forEach(function (h) { hdrs[h.name.toLowerCase()] = h.value; });
      const disp = hdrs["content-disposition"] || "";
      // Inline images (logos/signatures) carry a Content-ID and/or "inline"
      // disposition; real receipt attachments are "attachment".
      const inline = /inline/i.test(disp) || !!hdrs["content-id"];
      out.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
        inline: inline
      });
    }
    (part.parts || []).forEach(walk);
  })(msg.payload);
  return out;
}

/* ---- test helper: verify domain-wide delegation works before enabling the trigger ---- */
function testMailboxAccess() {
  const token = getMailboxToken(MAILBOX);
  const ids = gmailListMessageIds(token, MAILBOX, "from:lowes " + EMAIL_LOOKBACK);
  Logger.log("✅ Impersonated " + MAILBOX + " — found " + ids.length + " Lowe's message(s) in the lookback window.");
}