/**
 * googleChat.gs — native Google Chat from Apps Script.
 *
 * WHY THIS FILE EXISTS
 * Justin: "my AI always gets confused about how to connect with Google's chat."
 * That confusion is real and it has a specific cause, recorded here so nobody
 * (human or AI) re-derives it:
 *
 *   Composio LISTS google_chat as a toolkit and even exposes 8 GOOGLE_CHAT_*
 *   tools, but the toolkit has composio_managed_auth_schemes: []. There is NO
 *   OAuth flow behind it. Those tools return "No connected account found"
 *   forever, and no amount of clicking in the dashboard fixes it. Verified
 *   2026-08-20 against the live Composio API.
 *
 * The working path is the one below: Apps Script already runs AS the user, so
 * adding the chat.spaces scope to appsscript.json is the entire "connection".
 * No service account, no domain-wide delegation, no third-party hub.
 *
 * TWO WAYS TO POST, and they are NOT interchangeable:
 *
 *   1. WEBHOOK (postToChatWebhook_)
 *      A per-space URL you create in the space's own menu. No OAuth at all.
 *      Post-only: cannot read, cannot list spaces, cannot DM.
 *      Best for "the pipeline shouts into a room."
 *
 *   2. CHAT API as the user (chatListSpaces / chatPostMessage)
 *      Real API, needs the chat.spaces + chat.messages scopes in the manifest.
 *      Can list spaces and read membership. Posting to a space still requires
 *      that the app/user be a member of it.
 *
 * Webhook is what actually gets used day to day. The API functions are here
 * because "list the spaces" is how you find out where to put the webhook.
 */

const CHAT_WEBHOOK_PROP = "GOOGLE_CHAT_WEBHOOK_URL";

/**
 * Post to a Google Chat space via an incoming webhook.
 * Returns true on success. Never throws — alerting must not break a pipeline.
 */
function postToChatWebhook_(text, opts) {
  opts = opts || {};
  const props = PropertiesService.getScriptProperties();
  const url = opts.url || props.getProperty(CHAT_WEBHOOK_PROP);
  if (!url) {
    Logger.log("[CHAT] no webhook configured (" + CHAT_WEBHOOK_PROP + " unset)");
    return false;
  }
  try {
    const payload = { text: String(text).slice(0, 4000) };
    // threadKey groups related messages into one thread instead of spamming
    // the space with disconnected posts.
    const fullUrl = opts.threadKey
      ? url + "&threadKey=" + encodeURIComponent(opts.threadKey) +
        "&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
      : url;
    const res = UrlFetchApp.fetch(fullUrl, {
      method: "post",
      contentType: "application/json; charset=UTF-8",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code !== 200) {
      Logger.log("[CHAT] webhook HTTP " + code + ": " + res.getContentText().slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    Logger.log("[CHAT] webhook failed: " + e);
    return false;
  }
}

/**
 * List the Chat spaces this user can see. Requires the chat.spaces scope in
 * appsscript.json — if it is missing this throws a clear authorization error
 * rather than returning nothing.
 *
 * Use this to FIND the space you want, then create a webhook inside it.
 */
function chatListSpaces() {
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    "https://chat.googleapis.com/v1/spaces?pageSize=100", {
      method: "get",
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) {
    Logger.log("[CHAT] list spaces HTTP " + code);
    Logger.log(body.slice(0, 400));
    if (code === 403) {
      Logger.log("");
      Logger.log("403 usually means the chat.spaces scope is missing from");
      Logger.log("appsscript.json, OR the Chat API is not enabled on the");
      Logger.log("Cloud project behind this script.");
    }
    return null;
  }
  const spaces = (JSON.parse(body).spaces) || [];
  Logger.log("--- GOOGLE CHAT SPACES (" + spaces.length + ") ---");
  spaces.forEach(function (s) {
    Logger.log("  " + (s.displayName || "(direct message)") +
               "   name=" + s.name + "   type=" + (s.spaceType || s.type));
  });
  Logger.log("");
  Logger.log("To wire a webhook: open the space in Chat -> space name ->");
  Logger.log("Apps & integrations -> Webhooks -> Add webhook -> copy the URL,");
  Logger.log("then run setChatWebhook() with it.");
  return spaces;
}

/**
 * Post as the USER via the Chat API (not a webhook). Requires chat.messages
 * scope AND that this account is a member of the space.
 */
function chatPostMessage(spaceName, text) {
  if (!spaceName) { Logger.log("spaceName required, e.g. spaces/AAAA1234"); return false; }
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    "https://chat.googleapis.com/v1/" + spaceName + "/messages", {
      method: "post",
      contentType: "application/json; charset=UTF-8",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ text: String(text).slice(0, 4000) }),
      muteHttpExceptions: true
    });
  const code = res.getResponseCode();
  if (code !== 200) {
    Logger.log("[CHAT] post HTTP " + code + ": " + res.getContentText().slice(0, 300));
    return false;
  }
  Logger.log("Posted to " + spaceName);
  return true;
}

/** Store the webhook URL. Run once, then blank the argument out of history. */
function setChatWebhook(url) {
  if (!url) {
    Logger.log("Pass the webhook URL: setChatWebhook('https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...')");
    return;
  }
  PropertiesService.getScriptProperties().setProperty(CHAT_WEBHOOK_PROP, url);
  Logger.log("Stored " + CHAT_WEBHOOK_PROP + ".");
  const ok = postToChatWebhook_(
    "Receipt bot is connected to this space.\n\n" +
    "You'll see a message here when receipts need a human decision, or when " +
    "something breaks. Silence means it's running clean.");
  Logger.log(ok ? "Test message sent — check the space."
                : "Test FAILED. Re-copy the webhook URL (it must include both key= and token=).");
}

/** Read-only: is Chat wired up? Never prints the full URL. */
function checkChatSetup() {
  const url = PropertiesService.getScriptProperties().getProperty(CHAT_WEBHOOK_PROP);
  if (!url) {
    Logger.log(CHAT_WEBHOOK_PROP + ": MISSING — run chatListSpaces() to find your space,");
    Logger.log("then create a webhook in it and call setChatWebhook(url).");
    return false;
  }
  const m = url.match(/spaces\/([^\/]+)/);
  Logger.log(CHAT_WEBHOOK_PROP + ": set (space " + (m ? m[1] : "?") + ")");
  return true;
}
