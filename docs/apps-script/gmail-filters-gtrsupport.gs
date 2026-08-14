/**
 * Gmail filter setup — gtrsupport@goldentouchremodeling.com
 * Generated 2026-06-16 by the email rework (API filter writes blocked: token lacks gmail.settings.basic).
 *
 * This is the BACK-OFFICE / PAYROLL catch-all inbox (shared with mspencer@ and alan@mybusinesspartnernw.com).
 * Design rule: security, payroll, and finance mail ALWAYS stays in the inbox (never auto-archived),
 * because this mailbox exists to handle exactly that. Only true marketing/association noise is archived.
 *
 * Run once, signed in as gtrsupport@:
 *   1. script.google.com -> New project -> paste this file over Code.gs
 *   2. Left sidebar "Services" (+) -> add "Gmail API" (advanced service)
 *   3. Run > setupFilters -> approve the consent screen
 *   4. Check the execution log: every line should end "ok" or "skip".
 * Idempotent: re-running skips filters whose criteria already exist.
 */

var OLD_FILTER_IDS = []; // mailbox had zero filters at setup time

// add: label names (custom resolved to IDs at runtime; system names like IMPORTANT/INBOX pass through).
var FILTERS = [
  // ----- KEEP IN INBOX (label only; security / payroll / finance) -----
  { criteria: { from: 'gusto.com' },
    add: ['Payroll', 'IMPORTANT'] },                  // payroll runs + password/unlock/reset + employee changes
  { criteria: { from: 'bitwarden.com' },
    add: ['Security', 'IMPORTANT'] },                 // password manager security events
  { criteria: { from: 'accounts.google.com' },
    add: ['Security', 'IMPORTANT'] },                 // Google account security alerts (100% of this sender here)
  { criteria: { from: 'intuit.com' },
    add: ['Accounting / Payments', 'IMPORTANT'] },    // QuickBooks invites + Intuit login codes
  { criteria: { from: 'bryantbooks.com' },
    add: ['Accounting / Payments', 'IMPORTANT'] },    // outside bookkeeper
  { criteria: { from: 'goldentouchremodeling.com' },
    add: ['Internal'] },                              // internal/team mail, stays in inbox

  // ----- ARCHIVE (label + skip inbox + mark read; pure noise on this inbox) -----
  { criteria: { from: 'goldentouchremodeling.com', query: 'subject:{"sent you an estimate" "sent you an invoice"}' },
    add: ['Internal/ProBuild'], remove: ['INBOX', 'UNREAD'] },  // ProBuild auto-confirmations (rare here)
  { criteria: { from: 'e.lowes.com' },
    add: ['Vendors / Software'], remove: ['INBOX', 'UNREAD'] },  // Lowe's Pro marketing (NOT receipts)
  { criteria: { from: 'engage.canva.com' },
    add: ['Marketing'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { query: 'from:{biaofclarkcounty.org nahb.org biaw.com connectedcommunity.org}' },
    add: ['Associations'], remove: ['INBOX'] }
  // Deliberately NOT filtered: google.com (non-accounts) = Drive/Chat/Sheets share notices, operational; leave in inbox.
];

var EXPECTED_EMAIL = 'gtrsupport@goldentouchremodeling.com';

function setupFilters() {
  var me = Gmail.Users.getProfile('me');
  if (me.emailAddress !== EXPECTED_EMAIL) {
    throw new Error('Signed in as ' + me.emailAddress + ' — run this while signed in as ' + EXPECTED_EMAIL);
  }
  var byName = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) { byName[l.name] = l.id; });

  OLD_FILTER_IDS.forEach(function (id) {
    try { Gmail.Users.Settings.Filters.remove('me', id); Logger.log('delete ' + id.slice(0, 12) + '… ok'); }
    catch (e) { Logger.log('delete ' + id.slice(0, 12) + '… skip (' + e.message + ')'); }
  });

  var listResp = Gmail.Users.Settings.Filters.list('me'); // null when the mailbox has zero filters
  var existing = (listResp && listResp.filter) || [];
  var seen = {};
  existing.forEach(function (f) { seen[JSON.stringify(f.criteria)] = true; });

  FILTERS.forEach(function (spec) {
    var key = JSON.stringify(spec.criteria);
    if (seen[key]) { Logger.log('create ' + key + ' skip (exists)'); return; }
    var action = {};
    if (spec.add) action.addLabelIds = spec.add.map(function (n) {
      var id = byName[n] || n;
      if (!byName[n] && n !== n.toUpperCase()) throw new Error('Missing label: ' + n);
      return id;
    });
    if (spec.remove) action.removeLabelIds = spec.remove;
    Gmail.Users.Settings.Filters.create({ criteria: spec.criteria, action: action }, 'me');
    Logger.log('create ' + key + ' ok');
  });
  var afterResp = Gmail.Users.Settings.Filters.list('me');
  Logger.log('Done. Filters now: ' + (((afterResp && afterResp.filter) || []).length));
}
