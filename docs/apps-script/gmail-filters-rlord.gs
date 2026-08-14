/**
 * Gmail filter setup — rlord@goldentouchremodeling.com
 * Generated 2026-06-12 by the email rework (API filter writes blocked: token lacks gmail.settings.basic).
 *
 * Run once, signed in as rlord@ (Richard, or Justin via the rlord Chrome profile):
 *   1. script.google.com -> New project -> paste this file over Code.gs
 *   2. Left sidebar "Services" (+) -> add "Gmail API" (advanced service)
 *   3. Run > setupFilters -> approve the consent screen
 *   4. Check the execution log: every line should end "ok" or "skip".
 * Idempotent: re-running skips filters whose criteria already exist.
 */

// The 3 malformed filters from the old setup (deleted if still present).
var OLD_FILTER_IDS = [
  'ANe1BmhvZuU4MbIWJf7AC0fhcONau5Oi_H5-2eJDm_CLq2-WGUmWZeCeIeUHUKIyIRsBFmgvtQ', // from:"Houzz pro, Estimate"
  'ANe1BmgxkC03kKIH0CnhR30uJ5359vQjbYUbR87BfHrKlj0G895Z5J8nkG_sxjDBNJBNSNyfkQ', // subject:"Amazon,"
  'ANe1BmiBMygQdUVGwJTK3_0kBGzrymsD4PJlf3VPw7LOSqn3Q3U2EtxY6tbvMLuOEhTVWGiFtw'  // subject:"lowe´s, order"
];

var FILTERS = [
  { criteria: { from: 'goldentouchremodeling.com' },
    add: ['Internal', 'IMPORTANT'] },
  { criteria: { from: 'goldentouchremodeling.com', query: 'subject:{"sent you an estimate" "sent you an invoice"}' },
    add: ['Internal/ProBuild'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { query: 'from:{receipt.lowes.com notifications.lowes.com confirmation.lowes.com}' },
    add: ['Orders'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { query: 'from:{auto-confirm@amazon.com order-update@amazon.com shipment-tracking@amazon.com marketplace-messages@amazon.com}' },
    add: ['Orders'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { from: 'bryantbooks.com' }, // bookkeeper — stays in inbox
    add: ['Accounting / Payments', 'IMPORTANT'] },
  { criteria: { query: 'from:{biaofclarkcounty.org nahb.org biaw.com connectedcommunity.org}' },
    add: ['Associations'], remove: ['INBOX'] },
  { criteria: { query: 'from:{e.lowes.com em.lowesprotectionplus.com}' },
    add: ['Vendors / Software'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { query: 'from:{store-news@amazon.com business.amazon.com}' },
    add: ['Vendors / Software'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { from: 'rtacabinetstore.com' },
    add: ['Vendors / Software'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { from: 'em.officedepot.com' },
    add: ['Vendors / Software'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { query: 'from:{houzz.com mailer.houzz.com}' },
    add: ['Vendors / Software'], remove: ['INBOX'] },
  { criteria: { query: 'from:{google.com accounts.google.com gusto.com}' },
    add: ['Vendors / Software'], remove: ['INBOX'] },
  { criteria: { from: 'redfin.com' },
    add: ['Personal'], remove: ['INBOX', 'UNREAD'] }
  // Deliberately no rule for thertastore.com (mixed promos + real delivery threads)
  // or ardesignsinc.com / atlaslabinc.com (real project correspondence).
];

var EXPECTED_EMAIL = 'rlord@goldentouchremodeling.com';

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
