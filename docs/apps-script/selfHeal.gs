/**
 * selfHeal.gs — the receipt pipeline watches and repairs itself.
 *
 * Justin, 2026-08-19: "chron job watching it every 10 minutes, fixing it as
 * needed, improving it."
 *
 * WHAT THIS EXISTS TO PREVENT
 * From 08-10 to 08-19 the bot read nothing. gemini-2.5-pro was retired (404)
 * while the Cloud project was blocked for billing (403). Both entries in the
 * model chain died at once, every receipt burned its three attempts against a
 * dead API, and eleven good documents parked permanently. The only signal was
 * mail piling up in an inbox nobody watches. Nine days.
 *
 * Three functions, each safe to run on a trigger:
 *
 *   pipelineSelfHeal()   every 10 min, right after runReceiptAutomation
 *   pipelineHealthCheck() hourly — the canary
 *   pipelineDailyReport() once a day — the human summary
 *
 * DESIGN RULES (from the Kimi review of this incident)
 *  - Auto-requeue ONLY files parked because the AI was unavailable. A file the
 *    bot judged (non-receipt, duplicate, already emailed) is never touched.
 *  - Requeue only after PROOF the API works — a real generateContent call, not
 *    the /models listing endpoint, which lied throughout the outage.
 *  - Bound everything. Max 2 auto-requeues per file, max 10 files per pass.
 *    A wrong classifier must not create an infinite loop.
 *  - Escalate rather than retry silently. Repeated failure pages a human.
 */

const SELFHEAL_MAX_REQUEUES_PER_FILE = 2;
const SELFHEAL_MAX_FILES_PER_PASS    = 10;
const SELFHEAL_BACKLOG_ALERT         = 20;
const SELFHEAL_PROP_LAST_HEALTHY     = "selfheal_last_healthy_iso";
const SELFHEAL_PROP_LAST_ALERT       = "selfheal_last_alert_iso";
const SELFHEAL_ALERT_COOLDOWN_MIN    = 120;   // don't nag more than every 2h

/** A 1x1 white JPEG — enough to prove the endpoint accepts an image request. */
const SELFHEAL_TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/**
 * Can each model in the chain actually read an image RIGHT NOW?
 *
 * Deliberately calls generateContent. The /models listing endpoint returned
 * gemini-2.5-pro and gemini-2.5-flash happily all through the outage while
 * every real call 404'd and 403'd. Listing a model is not being able to use it.
 */
function checkVisionModels_() {
  const key = geminiApiKey_();
  const results = [];
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
                model + ":generateContent?key=" + key;
    const payload = {
      contents: [{
        parts: [
          { text: "Reply with the single word: OK" },
          { inline_data: { mime_type: "image/jpeg", data: SELFHEAL_TINY_JPEG } }
        ]
      }]
    };
    let code = 0, detail = "";
    try {
      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      code = res.getResponseCode();
      if (code !== 200) {
        try {
          const err = JSON.parse(res.getContentText()).error || {};
          detail = (err.status || "") + " " + String(err.message || "").slice(0, 110);
        } catch (e) { detail = res.getContentText().slice(0, 110); }
      }
    } catch (netErr) {
      detail = "network: " + String(netErr).slice(0, 100);
    }
    // 429 is quota — transient and self-clearing, not an outage.
    const ok = (code === 200 || code === 429);
    results.push({ model: model, ok: ok, code: code, detail: detail });
  }
  return results;
}

/** Files parked because the AI was UNAVAILABLE — the only auto-requeue class. */
function outageVictims_(folder) {
  const out = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName() === "desktop.ini") continue;
    let st = {};
    try { st = JSON.parse(f.getDescription() || "{}") || {}; } catch (e) { continue; }

    // Never touch a file the bot judged correctly.
    if (st.nonReceipt || st.duplicateOf || st.amazonAppOwned || st.emailed) continue;
    // ONLY outage victims. A file parked for zeroTotal or multiDoc was judged
    // on its CONTENT - requeueing replays the same verdict and burns the bounded
    // retry budget for nothing. (Kimi SHOULD-FIX: the first version requeued
    // every parked file, so a $0.00 receipt ate both auto-requeues re-deciding
    // what was already decided.)
    if (st.parkReason !== PARK_AI_UNAVAILABLE && st.parkReason !== PARK_GAVE_UP) continue;

    // A gaveUp park is only an outage victim if NOTHING decisive was ever learned.
    // If the AI truly read it and failed, a healthy API changes nothing - a human
    // must look.
    if (st.parkReason === PARK_GAVE_UP && Number(st.busyPasses || 0) === 0) continue;
    // Bound the loop.
    if (Number(st.autoRequeues || 0) >= SELFHEAL_MAX_REQUEUES_PER_FILE) continue;

    out.push({ file: f, state: st });
  }
  return out;
}

/**
 * Runs every 10 minutes after the main scan. Silent when healthy.
 */
function pipelineSelfHeal() {
  const props = PropertiesService.getScriptProperties();
  const health = checkVisionModels_();
  const working = health.filter(function (h) { return h.ok; });

  if (!working.length) {
    // Nothing can be read. Do NOT requeue into a dead API — that would burn
    // the bounded requeue budget for no reason. Alert and wait.
    const lines = health.map(function (h) {
      return "    " + h.model + ": HTTP " + h.code + " " + h.detail;
    }).join("\n");
    selfHealAlert_(
      "Receipt bot: AI IS DOWN — nothing can be read",
      "Every vision model failed a real read test.\n\n" + lines + "\n\n" +
      "Receipts will pile up in _Needs Review until this is fixed.\n" +
      "403 = the Google Cloud project is blocked (check billing at\n" +
      "      https://aistudio.google.com/apikey)\n" +
      "404 = the model was retired; update GEMINI_MODELS.\n\n" +
      "Nothing was requeued — that would waste the retry budget on a dead API.");
    return;
  }

  props.setProperty(SELFHEAL_PROP_LAST_HEALTHY, new Date().toISOString());

  // Some models dead but not all: worth knowing, not worth stopping for.
  const dead = health.filter(function (h) { return !h.ok; });
  if (dead.length) {
    Logger.log("[SELFHEAL] degraded chain: " +
      dead.map(function (d) { return d.model + " (" + d.code + ")"; }).join(", "));
  }

  // The API works — so anything parked for unavailability deserves another go.
  const folder = getOrCreateFolder(
    DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID), NEEDS_REVIEW_NAME);
  const victims = outageVictims_(folder).slice(0, SELFHEAL_MAX_FILES_PER_PASS);
  if (!victims.length) return;   // healthy and nothing stuck: stay silent

  const inbox = DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID);
  const freed = [];
  for (let i = 0; i < victims.length; i++) {
    const v = victims[i];
    const next = {};
    for (const k in v.state) {
      if (["attempts", "runs", "busyPasses", "parkReason", "parkAlerted",
           "lastError", "lastErrorAt"].indexOf(k) === -1) next[k] = v.state[k];
    }
    next.autoRequeues = Number(v.state.autoRequeues || 0) + 1;
    next.requeuedAt = new Date().toISOString();
    try {
      v.file.setDescription(JSON.stringify(next));
      v.file.moveTo(inbox);        // back into the scan path
      freed.push(v.file.getName());
    } catch (e) {
      Logger.log("[SELFHEAL] could not requeue " + v.file.getName() + ": " + e);
    }
  }

  if (freed.length) {
    Logger.log("[SELFHEAL] requeued " + freed.length + " file(s): " + freed.join(", "));
    selfHealAlert_(
      "Receipt bot: recovered " + freed.length + " receipt(s) automatically",
      "The AI is readable again, so receipts parked during the outage were put\n" +
      "back in the queue. They will process on the next run.\n\n  " +
      freed.join("\n  ") + "\n\n" +
      "No action needed — this message exists so the recovery is visible.");
  }
}

/** Hourly canary. Alerts the moment ANY model stops working. */
function pipelineHealthCheck() {
  const health = checkVisionModels_();
  const dead = health.filter(function (h) { return !h.ok; });
  if (!dead.length) return;                    // silence = healthy

  const allDead = dead.length === health.length;
  const lines = health.map(function (h) {
    return "    " + h.model + ": " + (h.ok ? "OK" : "HTTP " + h.code + " " + h.detail);
  }).join("\n");

  selfHealAlert_(
    allDead ? "Receipt bot: ALL vision models are down"
            : "Receipt bot: " + dead.length + " model(s) degraded",
    (allDead
      ? "Nothing can be read. Receipts are piling up.\n\n"
      : "The chain still works, but fix this before the rest go.\n\n") +
    lines + "\n\nChecked with a real image read, not the models list.");
}

/** Once a day: backlog and staleness. The lagging indicator, kept honest. */
function pipelineDailyReport() {
  const props = PropertiesService.getScriptProperties();
  const folder = getOrCreateFolder(
    DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID), NEEDS_REVIEW_NAME);

  let total = 0, stuck = 0;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName() === "desktop.ini") continue;
    total++;
    let st = {};
    try { st = JSON.parse(f.getDescription() || "{}") || {}; } catch (e) {}
    if (st.parkReason && !st.nonReceipt && !st.duplicateOf) stuck++;
  }

  const lastHealthy = props.getProperty(SELFHEAL_PROP_LAST_HEALTHY);
  const hoursSince = lastHealthy
    ? Math.round((Date.now() - new Date(lastHealthy).getTime()) / 3600000)
    : null;

  const problems = [];
  if (total >= SELFHEAL_BACKLOG_ALERT) {
    problems.push(total + " files in _Needs Review (" + stuck + " actionable).");
  }
  if (hoursSince !== null && hoursSince > 6) {
    problems.push("The AI has not passed a health check in " + hoursSince + " hours.");
  }
  if (!problems.length) return;                // silence = healthy

  selfHealAlert_("Receipt bot: daily check", problems.join("\n") +
    "\n\nRun auditNeedsReview() for a file-by-file verdict.");
}

/**
 * Send to Telegram as well as email.
 *
 * Kimi's sharpest finding: the whole 9-day outage happened because the ONLY
 * signal was mail to ALERT_EMAIL, an inbox nobody watches. Alerting to that
 * same inbox fixes nothing. Telegram is what Justin actually reads.
 * Credentials live in Script Properties (TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID) - never in code. Skipped silently if unset, and a
 * Telegram failure never blocks the email.
 */
function telegramAlert_(text) {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty("TELEGRAM_BOT_TOKEN");
    const chat  = props.getProperty("TELEGRAM_CHAT_ID");
    if (!token || !chat) return false;
    const res = UrlFetchApp.fetch(
      "https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ chat_id: chat, text: text.slice(0, 3900) }),
        muteHttpExceptions: true
      });
    return res.getResponseCode() === 200;
  } catch (e) {
    Logger.log("[SELFHEAL] telegram failed: " + e);
    return false;
  }
}

/** One alert channel, rate-limited so a broken pipeline cannot spam. */
function selfHealAlert_(subject, body) {
  const props = PropertiesService.getScriptProperties();
  const last = props.getProperty(SELFHEAL_PROP_LAST_ALERT);
  if (last) {
    const mins = (Date.now() - new Date(last).getTime()) / 60000;
    if (mins < SELFHEAL_ALERT_COOLDOWN_MIN) {
      Logger.log("[SELFHEAL] alert suppressed (cooldown): " + subject);
      return;
    }
  }
  props.setProperty(SELFHEAL_PROP_LAST_ALERT, new Date().toISOString());
  // Fan out to every channel that is actually watched. Each is
  // independent: one failing must never suppress the others, and none
  // of them may throw - a broken alert path cannot break the pipeline.
  // Google Chat is where the OFFICE sees it (Marge); Telegram is where
  // Justin sees it; email is the archive of record.
  try { postToChatWebhook_(subject + "\n\n" + body, { threadKey: "receipt-bot" }); }
  catch (e) { Logger.log("[SELFHEAL] chat alert failed: " + e); }
  // Telegram FIRST - it is the channel that gets read.
  telegramAlert_(subject + "\n\n" + body);
  try { MailApp.sendEmail(ALERT_EMAIL, subject, body); }
  catch (e) { Logger.log("[SELFHEAL] alert email failed: " + e); }
}

/**
 * Install the triggers. Run ONCE by hand; it clears its own duplicates first.
 */
function installSelfHealTriggers() {
  const wanted = {
    pipelineSelfHeal: "every10",
    pipelineHealthCheck: "hourly",
    pipelineDailyReport: "daily"
  };
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    if (wanted[existing[i].getHandlerFunction()]) {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger("pipelineSelfHeal").timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger("pipelineHealthCheck").timeBased().everyHours(1).create();
  ScriptApp.newTrigger("pipelineDailyReport").timeBased().everyDays(1).atHour(7).create();
  Logger.log("Installed: pipelineSelfHeal (10 min), pipelineHealthCheck (hourly), " +
             "pipelineDailyReport (daily 7am).");
}

/** Read-only: what would self-heal do right now? Changes nothing. */
function previewSelfHeal() {
  const health = checkVisionModels_();
  Logger.log("--- MODEL HEALTH (real image read) ---");
  for (let i = 0; i < health.length; i++) {
    const h = health[i];
    Logger.log("  " + (h.ok ? "OK   " : "DEAD ") + h.model +
               "  HTTP " + h.code + (h.detail ? "  " + h.detail : ""));
  }
  const folder = getOrCreateFolder(
    DriveApp.getFolderById(NEW_RECEIPTS_FOLDER_ID), NEEDS_REVIEW_NAME);
  const victims = outageVictims_(folder);
  Logger.log("");
  Logger.log("--- WOULD REQUEUE (" + victims.length + ") ---");
  for (let i = 0; i < victims.length; i++) {
    Logger.log("  " + victims[i].file.getName() +
               "  [park=" + victims[i].state.parkReason +
               " attempts=" + (victims[i].state.attempts || 0) +
               " autoRequeues=" + (victims[i].state.autoRequeues || 0) + "]");
  }
  Logger.log("");
  Logger.log("Nothing was changed. Run pipelineSelfHeal() to apply.");
}
