/**
 * Gmail filter setup — jadkins@goldentouchremodeling.com
 * Generated 2026-06-12 by the email rework (API filter writes blocked: token lacks gmail.settings.basic).
 *
 * Run once, signed in as jadkins@:
 *   1. script.google.com -> New project -> paste this file over Code.gs
 *   2. Left sidebar "Services" (+) -> add "Gmail API" (advanced service)
 *   3. Run > setupFilters -> approve the consent screen
 *   4. Check the execution log: every line should end "ok" or "skip".
 * Idempotent: re-running skips filters whose criteria already exist.
 */

// Old filters replaced by this set (deleted if still present).
var OLD_FILTER_IDS = [
  'ANe1BmiwcNHFxmPzZBIzCgquPztvo4IpDRm79Jl0xCLseXVIlLbXeUWi78_wQkKw98Qq7DFzjg', // angi.com -> Marketing+archive (was swallowing leads)
  'ANe1BmiJgiC9QxT4IQKsT6UTW5hYXzHhc3QmJFxmnzfkWfhrbehUkN9LQdEfQD6VQwLa-SEZwQ', // internal -> +STARRED (star bloat)
  'ANe1BmivnM3-CgCm9ksmG-ekZtDhkpZ90c7jvebyLoQq_m-n-NwQFXY86dHJ-CNTxAjsA_ll6w', // gmail.com -> +STARRED+never-spam
  'ANe1BmgKLshAlBpWSp5qSkUljAfSI4qpVXsyS2DNC8g343yHavC4dzKdIa8dNRcms81_XhIoGg', // moreestimates.co -> Marketing+archive
  'ANe1BmhxIkbneH925fAEff6TBIg_Gzb4sdKDsp7PgZaE2aUgyDakBa6e0_Ss78uuuEhT-fqzYA'  // moreestimates.com -> Marketing+archive
];

// add: label names (custom resolved to IDs at runtime; system names pass through).
var FILTERS = [
  { criteria: { from: 'angi.com', query: 'subject:{"New Customer Match" "Message Received"}' },
    add: ['Leads', 'IMPORTANT'] },
  { criteria: { from: 'angi.com', negatedQuery: 'subject:{"New Customer Match" "Message Received"}' },
    add: ['Marketing'], remove: ['INBOX'] },
  { criteria: { from: 'goldentouchremodeling.com' },
    add: ['IMPORTANT', 'Internal'] },
  { criteria: { from: 'gmail.com' },
    remove: ['SPAM'] }, // never-spam for client replies, no auto-star
  { criteria: { from: 'goldentouchremodeling.com', query: 'subject:{"sent you an estimate" "sent you an invoice"}' },
    add: ['Internal/ProBuild'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { from: 'intuit.com', subject: 'We got your email' },
    remove: ['INBOX', 'UNREAD'] }, // QBO receipt-forward ACKs
  { criteria: { from: 'notification.intuit.com', subject: 'Invoice' },
    add: ['Accounting / Payments'] },
  { criteria: { from: 'plaid.com' },
    add: ['Accounting / Payments'], remove: ['INBOX'] },
  { criteria: { from: 'vercel.com', negatedQuery: 'subject:production' },
    add: ['Dev'], remove: ['INBOX', 'UNREAD'] },
  { criteria: { from: 'vercel.com', query: 'subject:production' },
    add: ['Dev'] }, // prod deploy failures stay visible
  { criteria: { from: 'biaw.com' },
    add: ['Associations'], remove: ['INBOX'] },
  { criteria: { query: 'from:{moreestimates.co moreestimates.com} subject:{lead "estimate request"}' },
    add: ['Leads', 'IMPORTANT'] },
  { criteria: { from: 'moreestimates.co', negatedQuery: 'subject:{lead "estimate request"}' },
    add: ['Marketing'], remove: ['INBOX'] },
  { criteria: { from: 'moreestimates.com', negatedQuery: 'subject:{lead "estimate request"}' },
    add: ['Marketing'], remove: ['INBOX'] }
];

var EXPECTED_EMAIL = 'jadkins@goldentouchremodeling.com';

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
