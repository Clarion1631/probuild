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

/**
 * Reply INTO an existing thread via the Chat API, instead of posting a new
 * top-level message. Used by sweepChatReceipts.gs so "got it, thanks!" lands
 * next to the photo it's replying to instead of at the bottom of the space.
 * REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD means a thread that can no longer
 * take replies (e.g. deleted) still gets the message, just as a new thread,
 * so this never silently drops it. Requires chat.messages scope AND that
 * this account is a member of the space. Never throws.
 *
 * Returns the created message's resource name (a truthy string) on success,
 * false on failure. This runs under the jadkins@ USER token, not a bot
 * token, so the reply it posts comes back from messages.list on a later
 * sweep pass looking exactly like a human message from Justin. Returning the
 * name lets the caller (chatSweepReply_ in sweepChatReceipts.gs) record it as
 * already-SEEN immediately, so the sweep never reprocesses its own reply.
 */
function chatReplyInThread_(spaceName, threadName, text) {
  if (!spaceName || !threadName) {
    Logger.log("chatReplyInThread_ needs spaceName and threadName");
    return false;
  }
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    "https://chat.googleapis.com/v1/" + spaceName +
    "/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD", {
      method: "post",
      contentType: "application/json; charset=UTF-8",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({
        text: String(text).slice(0, 4000),
        thread: { name: threadName }
      }),
      muteHttpExceptions: true
    });
  const code = res.getResponseCode();
  if (code !== 200) {
    Logger.log("[CHAT] reply HTTP " + code + ": " + res.getContentText().slice(0, 300));
    return false;
  }
  try {
    const body = JSON.parse(res.getContentText() || "{}");
    if (!body.name) {
      Logger.log("[CHAT] reply HTTP 200 but response had no message name");
      return false;
    }
    Logger.log("Replied in thread " + threadName + " (message " + body.name + ")");
    return body.name;
  } catch (e) {
    Logger.log("[CHAT] reply HTTP 200 but failed to parse response: " + e);
    return false;
  }
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

/* ─────────────────────────────────────────────────────────────────────────
 * DIRECT MESSAGES — a different mechanism from webhooks. Read this.
 *
 * You CANNOT webhook a DM. An incoming webhook is registered inside a
 * specific space through that space's own UI, so there is no way to create
 * one for a 1:1 conversation with another person. Every "just make a webhook
 * to DM someone" attempt dead-ends here.
 *
 * The real path is the Chat API with USER auth:
 *   1. spaces.findDirectMessage?name=users/<email>  -> the DM space id
 *   2. spaces.messages.create on that space
 *
 * Both run as the signed-in Apps Script user, so the message genuinely comes
 * from that person's account. Requires chat.spaces.readonly + chat.messages
 * in appsscript.json, and the Chat API enabled on the script's Cloud project.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Find the 1:1 DM space between the running user and someone else.
 * Returns "spaces/XXXX" or null. Never throws.
 */
function chatFindDm(email) {
  if (!email) { Logger.log("chatFindDm needs an email"); return null; }
  try {
    const res = UrlFetchApp.fetch(
      "https://chat.googleapis.com/v1/spaces:findDirectMessage?name=" +
      encodeURIComponent("users/" + email), {
        method: "get",
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code !== 200) {
      Logger.log("[CHAT] findDirectMessage HTTP " + code);
      Logger.log(body.slice(0, 400));
      if (code === 403) {
        Logger.log("");
        Logger.log("403 means one of two things, and the error does not say which:");
        Logger.log("  a) the chat.spaces.readonly scope is missing -> re-authorize");
        Logger.log("  b) the Chat API is not enabled on this script's Cloud project");
        Logger.log("     -> Project Settings -> Google Cloud Platform project, then");
        Logger.log("        enable 'Google Chat API' in that project.");
      }
      if (code === 404) {
        Logger.log("No DM exists yet. Open Chat and send this person one message");
        Logger.log("by hand, then this will find it.");
      }
      return null;
    }
    const space = JSON.parse(body);
    Logger.log("DM space with " + email + ": " + space.name);
    return space.name;
  } catch (e) {
    Logger.log("[CHAT] findDirectMessage failed: " + e);
    return null;
  }
}

/**
 * Send a direct message to one person, as the running user.
 * Returns true on success.
 */
function chatSendDm(email, text) {
  const space = chatFindDm(email);
  if (!space) return false;
  return chatPostMessage(space, text);
}

/**
 * THE ONE TO RUN: DM Marge the receipt-process update.
 *
 * Everything is baked in so this is a single click. The message is written to
 * be openly AI-attributed — Justin asked for that explicitly ("let her know
 * it's AI that's saying it"), and it matters: a process change that lands
 * without a named author reads as a decree from nowhere.
 */
function dmMargeReceiptUpdate() {
  const MARGE = "gtrsupport@goldentouchremodeling.com";

  const msg =
"*Hey Marge — this is Justin's AI, writing on his behalf.* He asked me to let you know what changed with receipts.\n" +
"\n" +
"You know how you've been hunting receipts one bank line at a time? Your Aug 14 note said you got through 08/04 and were stuck on four of them — checked Drive, checked Lowe's.com, checked email. That part is done now. The system does it.\n" +
"\n" +
"*What runs on its own*\n" +
"A receipt shows up — email, photo, or dropped in a job folder. It gets read, named Job_Date_Vendor_Invoice_$Amount, checked against everything already filed, then sent to QuickBooks and archived. *14 receipts filed in the last two days with nobody touching them.*\n" +
"\n" +
"*What it now refuses to do*\n" +
"• Book a Cash App payment or payroll advance as an expense — those get held and flagged for Gusto\n" +
"• Book an Amazon order twice — Intuit's own app owns those now\n" +
"• Book the same charge twice\n" +
"\n" +
"*What broke before and doesn't now*\n" +
"The reader died for nine days in August. Receipts quietly gave up, and the only sign was email piling up. It now retries on its own and sends a text if it can't. Ten minutes is the longest a failure can go unnoticed.\n" +
"\n" +
"*What still needs you*\n" +
"• The items sitting in _Needs Review — that's real judgment work\n" +
"• Missing receipt memos — only a person can write and sign those\n" +
"• Assigning jobs inside QuickBooks — still manual\n" +
"\n" +
"*What you can stop doing*\n" +
"Working the bank line by line looking for receipts. What's left in _Needs Review is the actual work now.\n" +
"\n" +
"One honest note: this is intake through QuickBooks, not the whole receipt problem. The duplicate groups you found in your audit still need reconciling, and job assignment in QBO is still by hand.\n" +
"\n" +
"— Justin's AI";

  const ok = chatSendDm(MARGE, msg);
  Logger.log(ok ? "Sent to " + MARGE + " — check Chat."
                : "FAILED. Read the log above; it names the cause.");
  return ok;
}
