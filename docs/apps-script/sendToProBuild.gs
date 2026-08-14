/**
 * PROBUILD EXPENSE STEP — file "sendToProBuild.gs" in the "QBO Automation"
 * Apps Script project. Called from processSingleFile() at step 5.5 (already
 * wired in runReceiptAutomation.gs v2).
 *
 * What it does: posts the SAME category split the QBO email gets to ProBuild,
 * which creates one Pending expense per category, coded to the matching
 * project phase (cost code), with the Drive receipt image linked. Review
 * queue: ProBuild -> Field -> Receipts (/manager/receipts). They roll into
 * /reports/profitability automatically.
 *
 * Robustness, same philosophy as the rest of the script:
 *  - state.probuild guards re-sends (file description JSON).
 *  - ProBuild being DOWN throws -> the file stays in place and the next pass
 *    retries (QBO email is already marked sent, so no duplicate email).
 *  - A name-mismatch ("project-not-matched") does NOT block archiving — you
 *    get an alert email instead, because retrying won't fix a folder name.
 *  - Dedupe is double-safe: ProBuild also ignores any Drive file id it has
 *    already ingested, and v2's content dedup keeps the same purchase from
 *    arriving as two different files in the first place.
 */

const PROBUILD_INGEST_URL = "https://probuild.goldentouchremodeling.com/api/integrations/receipt-ingest";
// NOTE: move this to Config.gs / Script Properties; it is the RECEIPT_INGEST_SECRET.
const PROBUILD_INGEST_KEY = "gtr_ri_CvyumWPdU4gymekR5PErGToDxpfOEUFkK2tg3Wydis";

function sendExpensesToProBuild(file, ctx, aiData, isCheck, categoryGroups, totalAmount, dateStr, cleanInv, memo, state) {
  if (state.probuild) return; // already handled on a previous pass

  // Shop/overhead expenses live in QuickBooks only — ProBuild tracks JOB costs.
  if (ctx.isShop) {
    state.probuild = "skipped-shop";
    setState(file, state);
    return;
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
    fileUrl: "https://drive.google.com/file/d/" + file.getId() + "/view",
    fileName: file.getName(),
    groups: groups
  };

  const res = UrlFetchApp.fetch(PROBUILD_INGEST_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "x-ingest-key": PROBUILD_INGEST_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    // ProBuild unreachable / server error -> retry on the next pass.
    throw new Error("ProBuild ingest HTTP " + code + ": " + res.getContentText().slice(0, 300));
  }

  const body = JSON.parse(res.getContentText());
  if (body.ok) {
    state.probuild = true;
    setState(file, state);
    Logger.log("   >> ProBuild: " + (body.alreadyIngested ? "already ingested" : body.created + " expense(s) created for " + body.projectName));
    if (body.warnings && body.warnings.length) Logger.log("   >> ProBuild warnings: " + body.warnings.join(" | "));
  } else {
    // Not retryable (folder name doesn't match a project, no estimate, ...).
    state.probuild = "failed:" + (body.reason || "unknown");
    setState(file, state);
    MailApp.sendEmail(ALERT_EMAIL,
      "ProBuild expense needs attention: " + file.getName(),
      'ProBuild did not accept "' + file.getName() + '".\n' +
      "Reason: " + (body.reason || "unknown") + "\n" +
      "Drive folder: " + ctx.projectName + "\n" +
      (body.reason === "project-not-matched"
        ? "Fix: rename the Drive folder to match the ProBuild project name (or create the project in ProBuild), then add the expense manually in ProBuild — the QuickBooks copy already went through."
        : "The QuickBooks copy already went through; add the ProBuild expense manually."));
  }
}
