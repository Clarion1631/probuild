/**
 * setupTelegramAlerts.gs — one-time credential install + trigger setup.
 *
 * WHY THIS FILE EXISTS
 * The 9-day receipt outage (2026-08-10..19) was invisible because the ONLY
 * alert channel was email to ALERT_EMAIL, an inbox nobody watches. Fixing
 * the models without fixing the channel would have set up the next silent
 * outage. Telegram is the channel Justin actually reads.
 *
 * Credentials go in Script Properties, never in source — this file is in a
 * git repo. Paste the token below, run once, then CLEAR IT AGAIN before
 * committing (or just never commit the filled-in version).
 *
 * HOW TO RUN
 *   1. Fill in TG_TOKEN below.
 *   2. Select setupTelegramAlerts -> Run. It sends a test message.
 *   3. Blank TG_TOKEN out again.
 *   4. Select installSelfHealTriggers -> Run. (Registers the 10-min
 *      self-heal, hourly canary, and daily report. Apps Script does not
 *      allow creating triggers remotely, so this step is manual, once.)
 */

// Paste, run, then blank. Never commit a real value here.
const TG_TOKEN = "";
const TG_CHAT  = "8681967411";   // Justin's Telegram chat id

function setupTelegramAlerts() {
  if (!TG_TOKEN) {
    Logger.log("TG_TOKEN is empty — paste the bot token at the top of this file first.");
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty("TELEGRAM_BOT_TOKEN", TG_TOKEN);
  props.setProperty("TELEGRAM_CHAT_ID", TG_CHAT);
  Logger.log("Stored TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Script Properties.");

  const ok = telegramAlert_(
    "Receipt bot: alerts are wired to Telegram.\n\n" +
    "This is the channel that gets read. From now on a dead vision API, a " +
    "growing backlog, or an auto-recovery shows up here instead of dying " +
    "quietly in an inbox.\n\n" +
    "Silence means healthy.");
  Logger.log(ok ? "Test message sent — check Telegram."
                : "Test message FAILED. Check the token and chat id.");
}

/** Read-only: are the credentials present? Never prints the token. */
function checkTelegramSetup() {
  const props = PropertiesService.getScriptProperties();
  const tok = props.getProperty("TELEGRAM_BOT_TOKEN");
  const chat = props.getProperty("TELEGRAM_CHAT_ID");
  Logger.log("TELEGRAM_BOT_TOKEN: " + (tok ? "set (" + tok.length + " chars)" : "MISSING"));
  Logger.log("TELEGRAM_CHAT_ID:   " + (chat || "MISSING"));
  if (tok && chat) {
    Logger.log("Alerts will reach Telegram.");
  } else {
    Logger.log("Alerts fall back to email only — run setupTelegramAlerts().");
  }
}
