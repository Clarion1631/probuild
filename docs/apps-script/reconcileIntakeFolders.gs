/**
 * INTAKE FOLDER RECONCILER  (file "reconcileIntakeFolders.gs")
 *
 * The whole receipt pipeline keys off ONE canonical name: the ProBuild
 * project. The Drive intake folder must match it exactly (that's how the
 * scan routes receipts), and the QBO customer is auto-created from it. This
 * job stops the known drift modes:
 *
 *   1. A project goes In Progress in ProBuild but nobody creates its intake
 *      folder -> receipts have nowhere to be filed. FIX: auto-create it.
 *   2. Someone hand-creates a folder with a casual name ("Shed", "Hoppe
 *      Bathroom") -> receipts silently downgrade to the email path with
 *      nobody told. FIX: email a drift report.
 *
 * Runs at most once a day, called at the END of the receipt scan INSIDE the
 * script lock (single-instance — no duplicate-creation race; receipt
 * processing always gets the execution budget first). Every failure path is
 * swallowed after logging. Alert emails require a QUOTA RESERVE (> 1
 * remaining) so the reconciler can never eat the last send the pipeline's
 * own alerts need, and the report signature is only persisted AFTER a
 * successful send so a quota-skipped or failed report retries next day.
 */

const RECONCILE_PROJECTS_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-receipts/projects";
const RECONCILE_INTERVAL_MS = 22 * 60 * 60 * 1000; // ~daily, tolerant of trigger jitter

function reconcileIntakeFoldersDaily_() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty("RECONCILE_LAST_RUN_MS") || 0);
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return;
  // Stamp BEFORE the work: a crashing reconcile must not re-run every
  // 10 minutes all day (it would re-crash and re-log 144 times).
  props.setProperty("RECONCILE_LAST_RUN_MS", String(Date.now()));

  const ingestKey = props.getProperty("RECEIPT_INGEST_SECRET");
  if (!ingestKey) { Logger.log(" > [RECONCILE] skipped: no RECEIPT_INGEST_SECRET."); return; }

  let projectNames;
  try {
    const res = UrlFetchApp.fetch(RECONCILE_PROJECTS_URL, {
      method: "get",
      headers: { "x-ingest-key": ingestKey },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(" > [RECONCILE] skipped: projects endpoint HTTP " + res.getResponseCode());
      return;
    }
    const body = JSON.parse(res.getContentText());
    if (!body.ok || !Array.isArray(body.projects)) {
      Logger.log(" > [RECONCILE] skipped: unexpected response body.");
      return;
    }
    projectNames = body.projects.filter(function (n) { return typeof n === "string" && n.trim(); });
  } catch (e) {
    Logger.log(" > [RECONCILE] skipped: fetch failed: " + e);
    return;
  }

  // Same normalization the server's project matcher uses — the two sides
  // MUST agree or the reconciler would "fix" folders the push already matches.
  function norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

  // Object.create(null): project/folder names like "constructor" or
  // "toString" must never collide with Object.prototype keys.
  const unroutable = [];   // names the scan can never route ("_...")
  const eligible = [];     // candidates after Shop/underscore filtering

  projectNames.forEach(function (name) {
    // "Shop" is BY DESIGN: the overhead triage bucket. Its folder exists, the
    // scan routes it specially (email path), and the expense sync books its
    // costs to the ProBuild Shop project. Not drift, not unroutable — skip.
    if (norm(name) === "shop") return;
    // "_" prefix (same RAW check the scan uses on folders) = the scan would
    // skip this folder. Creating one would make a silent receipt black hole.
    if (name.startsWith("_")) {
      unroutable.push(name);
      return;
    }
    eligible.push(name);
  });

  // TWO-PASS collision handling: count normalized keys first so that NO
  // member of a colliding group ever creates a folder (creating "the first
  // one" would still be a coin-flip on endpoint ordering).
  const normCounts = Object.create(null);
  eligible.forEach(function (name) {
    const key = norm(name);
    normCounts[key] = (normCounts[key] || 0) + 1;
  });
  const projectByNorm = Object.create(null);
  const collisionsByKey = Object.create(null);
  const routable = [];
  eligible.forEach(function (name) {
    const key = norm(name);
    if (normCounts[key] > 1) {
      (collisionsByKey[key] = collisionsByKey[key] || []).push(name);
      projectByNorm[key] = name; // still counts as "matched" for drift purposes
      return;
    }
    projectByNorm[key] = name;
    routable.push(name);
  });
  // Canonical, order-independent pair strings — endpoint ordering must not
  // flap the report signature.
  const collisions = Object.keys(collisionsByKey).map(function (key) {
    return collisionsByKey[key].sort().join("  <->  ");
  });

  const root = DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID);
  const folderByNorm = Object.create(null);
  const duplicateFolders = [];
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    if (name.startsWith("_")) continue; // _Needs Review, _Archive ... etc.
    const key = norm(name);
    if (folderByNorm[key]) {
      // Two sibling folders that normalize identically: receipts split
      // between them arbitrarily. Surface it instead of silently keeping one.
      duplicateFolders.push(folderByNorm[key] + "  <->  " + name);
      continue;
    }
    folderByNorm[key] = name;
  }

  // One-shot events lost to a failed/deferred send are carried forward here
  // so a creation can never go permanently unreported (the folder exists next
  // day, so `created` alone would be empty and silent).
  let carried = [];
  try { carried = JSON.parse(props.getProperty("RECONCILE_PENDING_ONESHOT") || "[]"); } catch (e) { carried = []; }

  const created = [];
  const createFailed = [];

  // Projects with no folder -> create it with the EXACT canonical name.
  routable.forEach(function (name) {
    const key = norm(name);
    if (folderByNorm[key]) return;
    try {
      root.createFolder(name);
      folderByNorm[key] = name; // a same-run collision can't create a twin
      created.push(name);
    } catch (e) {
      createFailed.push(name + " (" + e + ")");
      Logger.log(" > [RECONCILE] could not create folder \"" + name + "\": " + e);
    }
  });

  // Folders matching no in-progress project -> drift (their receipts take
  // the email path). "shop" is the overhead bucket and always legitimate.
  const drift = [];
  Object.keys(folderByNorm).forEach(function (key) {
    if (key === "shop") return;
    if (!projectByNorm[key]) drift.push(folderByNorm[key]);
  });

  if (created.length) Logger.log(" > [RECONCILE] created intake folder(s): " + created.join(", "));
  if (drift.length) Logger.log(" > [RECONCILE] drift folder(s): " + drift.join(", "));

  // One-shot events (created / createFailed) always deserve an email.
  // PERSISTENT conditions (drift, collisions, unroutable names — e.g. the
  // ProBuild project literally named "Shop" will sit in unroutable forever)
  // email only when the SET changes, or they'd nag daily. The signature is
  // stored only after a SUCCESSFUL send, so a quota-skipped or failed report
  // retries tomorrow instead of being lost.
  const persistentSig = JSON.stringify({
    d: drift.slice().sort(),
    x: collisions.slice().sort(),
    u: unroutable.slice().sort(),
    f: duplicateFolders.slice().sort()
  });
  const persistentChanged = persistentSig !== props.getProperty("RECONCILE_DRIFT_SIG");
  const allCreated = carried.concat(created);
  const oneShot = allCreated.length || createFailed.length;
  const anythingPersistent = drift.length || collisions.length || unroutable.length || duplicateFolders.length;
  if (!oneShot && !persistentChanged) return;
  if (!oneShot && persistentChanged && !anythingPersistent) {
    // Everything resolved: go quiet, but remember the clean state.
    props.setProperty("RECONCILE_DRIFT_SIG", persistentSig);
    return;
  }
  // QUOTA RESERVE: never consume the last remaining send — the receipt
  // pipeline's own alerts (parked files, 401s) outrank this report. Carry
  // today's creations forward so the deferred report still mentions them.
  if (MailApp.getRemainingDailyQuota() <= 1) {
    if (allCreated.length) props.setProperty("RECONCILE_PENDING_ONESHOT", JSON.stringify(allCreated));
    Logger.log(" > [RECONCILE] report deferred: mail quota reserve.");
    return;
  }

  let bodyText = "Receipt intake folder reconciliation (ProBuild is the canonical name source):\n\n";
  if (allCreated.length) {
    bodyText += "CREATED intake folders for in-progress projects that had none:\n" +
      allCreated.map(function (n) { return "  + " + n; }).join("\n") + "\n\n";
  }
  if (createFailed.length) {
    bodyText += "FAILED to create these folders (will retry daily — check Drive permissions):\n" +
      createFailed.map(function (n) { return "  ! " + n; }).join("\n") + "\n\n";
  }
  if (collisions.length) {
    bodyText += "PROJECT NAME COLLISIONS in ProBuild (two in-progress projects whose names\n" +
      "differ only by case/spacing — receipts CANNOT be routed until one is renamed):\n" +
      collisions.map(function (n) { return "  x " + n; }).join("\n") + "\n\n";
  }
  if (unroutable.length) {
    bodyText += "UNROUTABLE PROJECT NAMES (start with _, which the receipt scan skips —\n" +
      "rename the ProBuild project or its receipts can never be filed):\n" +
      unroutable.map(function (n) { return "  ~ " + n; }).join("\n") + "\n\n";
  }
  if (duplicateFolders.length) {
    bodyText += "DUPLICATE INTAKE FOLDERS (same name up to case/spacing — receipts split\n" +
      "between them arbitrarily; merge their contents and archive one):\n" +
      duplicateFolders.map(function (n) { return "  = " + n; }).join("\n") + "\n\n";
  }
  if (drift.length) {
    bodyText += "FOLDERS THAT MATCH NO IN-PROGRESS PROBUILD PROJECT — receipts dropped in\n" +
      "these will NOT be auto-booked to a job (they fall back to the QBO email inbox):\n" +
      drift.map(function (n) { return "  ? " + n; }).join("\n") + "\n\n" +
      "Fix: rename the folder to the exact ProBuild project name, or archive it\n" +
      "(prefix with _ ) if the job is finished.\n";
  }

  try {
    MailApp.sendEmail(ALERT_EMAIL, "Receipt bot: intake folder report", bodyText);
    props.setProperty("RECONCILE_DRIFT_SIG", persistentSig);      // persisted ONLY on success
    props.deleteProperty("RECONCILE_PENDING_ONESHOT");            // carried creations delivered
  } catch (e) {
    if (allCreated.length) props.setProperty("RECONCILE_PENDING_ONESHOT", JSON.stringify(allCreated));
    Logger.log(" > [RECONCILE] report email failed (will retry tomorrow): " + e);
  }
}
