/**
 * requeueParkedReceipts.gs — un-park receipts after an outage.
 *
 * WHY THIS EXISTS
 * The receipt bot keeps its per-file state in the Drive file's DESCRIPTION
 * field: {attempts, runs, busyPasses, parkReason, parkAlerted}. Once
 * attempts hits MAX_AI_ATTEMPTS (3) the file is parked in _Needs Review and
 * shouldGiveUp_() will keep giving up on it FOREVER — even after the
 * underlying problem is fixed.
 *
 * That is correct for a genuinely unreadable document and wrong after an
 * outage. From 2026-08-10 to 08-19 every read failed for two reasons that
 * had nothing to do with the files: gemini-2.5-pro was retired (404) and
 * the Cloud project was blocked for unlinked billing (403). Eleven good
 * receipts burned their three attempts against a dead API. The Fred Meyer
 * receipt that failed 3/3 reads perfectly — vendor, date and total are
 * plainly legible.
 *
 * Clearing the counters puts those files back in the queue.
 *
 * HOW TO RUN
 *   1. Apps Script editor → select `previewParkedReceipts` → Run.
 *      Read the log. Nothing is modified.
 *   2. If the list looks right, run `requeueParkedReceipts`.
 *   3. Then run the normal receipt scan (or wait for its trigger).
 *
 * SAFETY
 *  - Only touches files whose state shows a park/attempt count. A file with
 *    clean state is left alone.
 *  - Preserves every other key in the description (splitFrom, split, etc.);
 *    only the retry counters and park flags are cleared.
 *  - Never deletes or moves a file. Worst case, a genuinely unreadable
 *    receipt gets three more attempts and parks itself again.
 */

// Must match the folder the main script parks into.
const REQUEUE_FOLDER_NAME = "_Needs Review";

/** Counters and flags that gate a retry. Everything else is preserved. */
const REQUEUE_CLEARED_KEYS = [
  "attempts", "runs", "busyPasses", "parkReason", "parkAlerted",
  "lastError", "lastErrorAt",
];

function previewParkedReceipts() {
  requeueParkedReceipts_(true);
}

function requeueParkedReceipts() {
  requeueParkedReceipts_(false);
}

function requeueParkedReceipts_(dryRun) {
  const folders = DriveApp.getFoldersByName(REQUEUE_FOLDER_NAME);
  if (!folders.hasNext()) {
    Logger.log('FOLDER NOT FOUND: "' + REQUEUE_FOLDER_NAME + '"');
    return;
  }
  const folder = folders.next();
  Logger.log((dryRun ? "--- PREVIEW (no changes) ---" : "--- REQUEUE ---") +
             ' folder: ' + folder.getName());

  const files = folder.getFiles();
  let seen = 0, changed = 0, skipped = 0;

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (name === "desktop.ini") continue;
    seen++;

    let state = {};
    try { state = JSON.parse(file.getDescription() || "{}") || {}; }
    catch (e) { state = {}; }

    const attempts = Number(state.attempts) || 0;
    const runs     = Number(state.runs) || 0;
    const busy     = Number(state.busyPasses) || 0;
    const park     = state.parkReason || "";

    if (!attempts && !runs && !busy && !park) {
      skipped++;
      Logger.log("  skip (clean state): " + name);
      continue;
    }

    Logger.log("  " + (dryRun ? "would clear" : "CLEARED") + ": " + name +
               "  [attempts=" + attempts + " runs=" + runs +
               " busy=" + busy + " park=" + (park || "-") + "]");

    if (!dryRun) {
      // Preserve unrelated keys — splitFrom/split matter to the splitter.
      const next = {};
      for (const k in state) {
        if (REQUEUE_CLEARED_KEYS.indexOf(k) === -1) next[k] = state[k];
      }
      next.requeuedAt = new Date().toISOString();
      file.setDescription(JSON.stringify(next));
    }
    changed++;
  }

  Logger.log("");
  Logger.log("Files seen:    " + seen);
  Logger.log("Files " + (dryRun ? "to clear:  " : "cleared:   ") + changed);
  Logger.log("Already clean: " + skipped);
  if (dryRun) {
    Logger.log("");
    Logger.log("Nothing was modified. Run requeueParkedReceipts() to apply.");
  } else {
    Logger.log("");
    Logger.log("Now run the normal receipt scan to process them.");
  }
}
