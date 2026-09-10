// scripts/lib/receipt-outcome-audit.mjs
// Pure, read-only summarizer for the receipt affidavit outcome audit.
// No I/O, no clock, no network, no mutation of its input. See docs/RECEIPT-OUTCOME-AUDIT.md.

const BANK_LINE = 'bank-line';
const ISO_TZ = /(Z|[+-]\d\d:?\d\d)$/;
const OPEN_STAGES = new Set(['pending', 'awaiting_purchaser', 'uncertain_delivery', 'unresolved']);
const CONFLICT_FLAGS = [
  'identity_conflict', 'artifact_pdf_conflict', 'artifact_conflict', 'artifact_pdf_mismatch',
  'resolution_without_artifact', 'artifact_without_resolution', 'artifact_without_issue', 'memo_conflict',
  'duplicate_open_issue', 'issue_details_unknown', 'issue_evidence_unknown', 'artifact_evidence_unknown',
];

export const COHORT_DEFINITION = 'Union of bank-line ReviewIssue targetKeys and targetKeys named by immutable ReceiptRequestCard items in the supplied snapshot, deduplicated by targetKey. Artifacts bind by targetType/targetKey (natural key), not issueId, so issue recreation is tolerated.';

export const LIMITATIONS = Object.freeze([
  'Snapshot scope is the persisted rows supplied, not the full business population; eligibleRequests is therefore null.',
  'postedToChat means the provider accepted the post (valid non-future postedAt plus messageName and threadName in the same Chat space). Purchaser delivery and bridge acknowledgement are never observed here and stay null; collect the bridge journal and ACKs separately.',
  'signedArtifactRecorded and filedInProbuild are the same backed evidence: issue resolution memo-signed plus exactly one artifact on the same natural key carrying the same pdfId. No Drive PDF re-verification is performed.',
  'Card status, attempts, and delivery reservations are not proof of a post; POSTING or UNCERTAIN without a valid post is uncertain, not failed.',
  'retry counts resendQueuedAt only; error counts non-empty lastError only. Flags may overlap; counts are per target, not per card. No success rate is computed because no denominator is observed.',
  'A missing source array or malformed JSON makes dependent metrics null (unknown), never zero.',
  'Scheduler and pipeline health (GET /api/health/pipeline) is a separate, independent signal and is not consulted or inferred.',
  'associations list only provider-verified request cards (card id, request id, thread, message, post time, item number, fingerprint) and the single accepted artifact (pdf id, created time). Card and artifact evidence carry separate absent / conflict / unavailable / verified statuses; malformed association data fails closed to conflict or unavailable and never changes a count.',
]);

const isNonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// The server derives this via the shared bridge helper; validate offline snapshots too.
export function isReceiptRequestId(v) {
  if (typeof v !== 'string') return false;
  const m = /^receipt-req-([A-Za-z][A-Za-z0-9_-]*)-(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (!m) return false;
  const t = Date.parse(m[2] + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === m[2];
}
const ARTIFACT_CONFLICT_FLAGS = ['identity_conflict', 'duplicate_open_issue', 'artifact_conflict', 'artifact_pdf_conflict', 'artifact_pdf_mismatch', 'artifact_without_resolution', 'artifact_without_issue'];

function isProviderPost(c, nowMs) {
  const postTime = parseIso(c.postedAt);
  const messageSpace = typeof c.messageName === 'string' ? /^spaces\/([^/]+)\/messages\/[^/]+$/.exec(c.messageName)?.[1] : null;
  const threadSpace = typeof c.threadName === 'string' ? /^spaces\/([^/]+)\/threads\/[^/]+$/.exec(c.threadName)?.[1] : null;
  return postTime !== null && postTime <= nowMs && !!messageSpace && messageSpace === threadSpace;
}

export function parseIso(v) {
  if (!isNonEmpty(v) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function assertNow(now) {
  const ms = typeof now === 'string' && ISO_TZ.test(now) ? parseIso(now) : null;
  if (ms === null) throw new TypeError('now must be an ISO 8601 timestamp with an explicit timezone');
  return ms;
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function evaluateTarget(targetKey, t, { nowMs, issuesUnknown, cardsUnknown, artifactsUnknown }) {
  const flags = new Set(t.flags);
  const issues = [...t.issues].sort((a, b) => (parseIso(b.createdAt) ?? 0) - (parseIso(a.createdAt) ?? 0));
  const issue = issues[0] || null;
  if (issues.length > 1) {
    flags.add('identity_conflict');
    if (issues.filter((i) => i.clearedAt == null).length > 1) flags.add('duplicate_open_issue');
  }
  if (!issue) flags.add('missing_issue');
  if (issue && issue.detailsBad) flags.add('issue_details_unknown');

  let hasPosted = false, hasInflight = false, hasPending = false;
  for (const c of t.cards) {
    const posted = isProviderPost(c, nowMs);
    if (posted) hasPosted = true;
    else if (c.status === 'PENDING') hasPending = true;
    else {
      hasInflight = true;
      if (c.status === 'POSTED') flags.add('posted_status_unverified');
      else if (c.status !== 'POSTING' && c.status !== 'UNCERTAIN') flags.add('card_status_unknown');
    }
    if (isNonEmpty(c.lastError)) flags.add('card_error');
    if (c.resendQueuedAt != null) flags.add('retry_queued');
  }
  let postedToChat;
  if (hasPosted) postedToChat = true;
  else if (cardsUnknown) { postedToChat = null; flags.add('card_evidence_incomplete'); }
  else if (hasInflight) postedToChat = null;
  else { postedToChat = false; if (t.cards.length === 0) flags.add('no_request_card'); }

  const arts = t.artifacts;
  const res = issue && !issue.detailsBad ? issue.details.resolution : undefined;
  if (issuesUnknown) flags.add('issue_evidence_unknown');
  if (artifactsUnknown) flags.add('artifact_evidence_unknown');
  let signed, filed, filedArtifact = null;
  if (issuesUnknown) { signed = filed = null; flags.add('issue_evidence_unknown'); }
  else if (artifactsUnknown) { signed = filed = null; flags.add('artifact_evidence_unknown'); }
  else if (issue && issue.detailsBad) { signed = filed = null; }
  else if (!issue) { signed = filed = false; if (arts.length) flags.add('artifact_without_issue'); }
  else if (res === 'memo-signed') {
    signed = filed = false;
    if (arts.length === 0) flags.add('resolution_without_artifact');
    else if (arts.length > 1) flags.add('artifact_conflict');
    else if (!isNonEmpty(issue.details.pdfId) || arts[0].pdfId !== issue.details.pdfId) flags.add('artifact_pdf_mismatch');
    else if (!CONFLICT_FLAGS.some((f) => flags.has(f))) { signed = filed = true; filedArtifact = arts[0]; }
  } else {
    signed = filed = false;
    if (res === 'memo-conflict') flags.add('memo_conflict');
    if (arts.length) flags.add('artifact_without_resolution');
  }

  let stage;
  if (filed === true) stage = 'filed_in_probuild';
  else if (CONFLICT_FLAGS.some((f) => flags.has(f))) stage = 'unresolved';
  else if (issue && issue.clearedAt != null) stage = 'closed_without_memo';
  else if (postedToChat === true) stage = 'awaiting_purchaser';
  else if (postedToChat === null) stage = 'uncertain_delivery';
  else if (hasPending) stage = 'pending';
  else stage = 'unresolved';

  let elapsedMs = null;
  const fo = issue ? parseIso(issue.firstObservedAt) : null;
  if (issue && fo === null) flags.add('first_observed_invalid');
  else if (issue && fo > nowMs) flags.add('first_observed_future');
  if (stage === 'filed_in_probuild') {
    const ac = parseIso(filedArtifact.createdAt);
    if (fo === null || fo > nowMs) flags.add('elapsed_unavailable');
    else if (ac === null) flags.add('artifact_created_invalid');
    else if (ac > nowMs) flags.add('artifact_created_future');
    else if (ac < fo) flags.add('timestamp_out_of_order');
    else elapsedMs = ac - fo;
  } else if (OPEN_STAGES.has(stage)) {
    if (issue && fo !== null && fo <= nowMs) elapsedMs = nowMs - fo; else flags.add('elapsed_unavailable');
  }

  // Associations: evidence only, never a substitute for the counts above.
  /** @type {'absent' | 'conflict' | 'unavailable' | 'verified'} */
  let cardEvidence;
  let assocCards = null;
  if (cardsUnknown) cardEvidence = 'unavailable';
  else {
    const valid = [];
    let conflict = false, unavailable = false;
    for (const { card: c, item, bad, req } of t.cardItems) {
      if (bad || req === 'bad') conflict = true;
      else if (req === 'missing') unavailable = true;
      else if (!isProviderPost(c, nowMs) && c.status !== 'PENDING') unavailable = true;
      else if (isProviderPost(c, nowMs)) valid.push({ cardId: c.id, requestId: c.requestId, threadName: c.threadName, messageName: c.messageName, postedAt: c.postedAt, itemNumber: item.n, fingerprint: item.fingerprint });
    }
    if (conflict) { cardEvidence = 'conflict'; }
    else if (unavailable) { cardEvidence = 'unavailable'; }
    else { assocCards = valid.sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0)); cardEvidence = valid.length ? 'verified' : 'absent'; }
  }
  /** @type {'absent' | 'conflict' | 'unavailable' | 'verified'} */
  let artifactEvidence;
  let filedArtifactOut = null;
  if (issuesUnknown || artifactsUnknown || (issue && issue.detailsBad)) artifactEvidence = 'unavailable';
  else if (ARTIFACT_CONFLICT_FLAGS.some((f) => flags.has(f))) artifactEvidence = 'conflict';
  else if (filed === true) { artifactEvidence = 'verified'; filedArtifactOut = { pdfId: filedArtifact.pdfId, createdAt: parseIso(filedArtifact.createdAt) === null || parseIso(filedArtifact.createdAt) > nowMs ? null : filedArtifact.createdAt }; }
  else if (arts.length === 0) artifactEvidence = 'absent';
  else artifactEvidence = 'conflict';
  const associations = { cards: assocCards, cardEvidence, filedArtifact: filedArtifactOut, artifactEvidence };

  return {
    targetKey,
    issueId: issue ? issue.id : null,
    requestCardIds: [...new Set(t.cards.map((c) => c.id))].sort(),
    stage,
    postedToChat,
    deliveredToPurchaser: null,
    signedArtifactRecorded: signed,
    filedInProbuild: filed,
    bridgeAck: null,
    elapsedMs,
    flags: [...flags].sort(),
    associations,
  };
}

export function auditReceiptOutcomes(snapshot, now) {
  const nowMs = assertNow(now);
  if (!isObj(snapshot)) throw new TypeError('snapshot must be an object');
  const evidenceErrors = [];
  const addErr = (code) => { if (!evidenceErrors.includes(code)) evidenceErrors.push(code); };
  const src = {};
  for (const k of ['issues', 'cards', 'artifacts']) {
    const v = snapshot[k];
    if (v == null) src[k] = null;
    else if (Array.isArray(v)) src[k] = v;
    else { src[k] = null; addErr(`${k}_not_array`); }
  }
  let issuesUnknown = src.issues === null;
  let cardsUnknown = src.cards === null;
  let artifactsUnknown = src.artifacts === null;
  let detailsUnknown = false;

  const targets = new Map();
  const tgt = (key) => {
    let t = targets.get(key);
    if (!t) { t = { issues: [], cards: [], artifacts: [], cardItems: [], flags: new Set(), inCohort: false }; targets.set(key, t); }
    return t;
  };

  const issueIds = new Map();
  for (const it of src.issues || []) {
    if (!isObj(it)) { addErr('issue_row_malformed'); issuesUnknown = true; continue; }
    if (it.targetType !== BANK_LINE) continue;
    if (!isNonEmpty(it.targetKey)) { addErr('issue_target_missing'); issuesUnknown = true; continue; }
    const t = tgt(it.targetKey); t.inCohort = true;
    if (!isNonEmpty(it.id) || issueIds.has(it.id)) {
      addErr('issue_identity_conflict'); t.flags.add('identity_conflict');
      if (issueIds.has(it.id)) tgt(issueIds.get(it.id)).flags.add('identity_conflict');
      continue;
    }
    issueIds.set(it.id, it.targetKey);
    let details = {}, detailsBad = false;
    if (it.displayDetails != null) {
      const p = parseJson(it.displayDetails);
      if (p.ok && isObj(p.value)) details = p.value; else { detailsBad = true; detailsUnknown = true; addErr('issue_details_malformed'); }
    }
    t.issues.push({ id: it.id, firstObservedAt: it.firstObservedAt, clearedAt: it.clearedAt, createdAt: it.createdAt, details, detailsBad });
  }

  const cardIds = new Set();
  for (const c of src.cards || []) {
    if (!isObj(c)) { addErr('card_row_malformed'); cardsUnknown = true; continue; }
    if (!isNonEmpty(c.id) || cardIds.has(c.id)) {
      addErr('card_identity_conflict'); cardsUnknown = true;
      for (const prior of targets.values()) {
        if (prior.cards.some((pc) => pc.id === c.id)) prior.flags.add('identity_conflict');
      }
      continue;
    }
    cardIds.add(c.id);
    const p = parseJson(c.itemsJson);
    if (!p.ok || !Array.isArray(p.value)) { addErr('card_items_malformed'); cardsUnknown = true; continue; }
    const seen = new Set(), seenN = new Set(), entries = [];
    let assocBad = false;
    for (const item of p.value) {
      if (!isObj(item) || !isNonEmpty(item.targetKey)) { addErr('card_item_malformed'); cardsUnknown = true; continue; }
      if (!Number.isSafeInteger(item.n) || item.n < 1 || seenN.has(item.n) || item.fingerprint !== `pb-${item.targetKey}`) assocBad = true;
      seenN.add(item.n);
      if (seen.has(item.targetKey)) { assocBad = true; continue; }
      seen.add(item.targetKey);
      const t = tgt(item.targetKey); t.inCohort = true; t.cards.push(c);
      entries.push({ t, item });
    }
    const req = c.requestId == null ? 'missing' : isReceiptRequestId(c.requestId) ? 'ok' : 'bad';
    for (const { t, item } of entries) t.cardItems.push({ card: c, item, bad: assocBad, req });
  }

  const artifactIds = new Map(), pdfOwner = new Map();
  for (const a of src.artifacts || []) {
    if (!isObj(a)) { addErr('artifact_row_malformed'); artifactsUnknown = true; continue; }
    if (a.targetType !== BANK_LINE) continue;
    if (!isNonEmpty(a.targetKey)) { addErr('artifact_target_missing'); artifactsUnknown = true; continue; }
    const t = tgt(a.targetKey);
    if (!isNonEmpty(a.id) || artifactIds.has(a.id)) {
      addErr('artifact_identity_conflict'); t.flags.add('identity_conflict');
      if (artifactIds.has(a.id)) tgt(artifactIds.get(a.id)).flags.add('identity_conflict');
      continue;
    }
    artifactIds.set(a.id, a.targetKey);
    if (!isNonEmpty(a.pdfId)) { addErr('artifact_pdf_missing'); t.flags.add('artifact_conflict'); continue; }
    const prev = pdfOwner.get(a.pdfId);
    if (prev !== undefined && prev !== a.targetKey) { addErr('artifact_pdf_identity_conflict'); t.flags.add('artifact_pdf_conflict'); tgt(prev).flags.add('artifact_pdf_conflict'); }
    else if (prev === a.targetKey) { addErr('artifact_duplicate'); t.flags.add('artifact_conflict'); }
    pdfOwner.set(a.pdfId, a.targetKey);
    t.artifacts.push({ pdfId: a.pdfId, createdAt: a.createdAt });
  }

  const rows = [];
  for (const [targetKey, t] of targets) {
    if (!t.inCohort) { addErr('artifact_without_target'); continue; }
    rows.push(evaluateTarget(targetKey, t, { nowMs, issuesUnknown, cardsUnknown, artifactsUnknown }));
  }
  rows.sort((a, b) => (a.targetKey < b.targetKey ? -1 : a.targetKey > b.targetKey ? 1 : 0));

  const count = (pred) => rows.filter(pred).length;
  const memoUnknown = issuesUnknown || artifactsUnknown || detailsUnknown;
  const anyUnknown = memoUnknown || cardsUnknown;
  const counts = {
    observedTargets: issuesUnknown || cardsUnknown ? null : rows.length,
    eligibleRequests: null,
    postedToChat: cardsUnknown ? null : count((r) => r.postedToChat === true),
    deliveredToPurchaser: null,
    awaitingPurchaser: anyUnknown ? null : count((r) => r.stage === 'awaiting_purchaser'),
    signedArtifactsRecorded: memoUnknown ? null : count((r) => r.signedArtifactRecorded === true),
    filedInProbuild: memoUnknown ? null : count((r) => r.filedInProbuild === true),
    bridgeAck: null,
    unresolved: anyUnknown ? null : count((r) => OPEN_STAGES.has(r.stage)),
    pending: anyUnknown ? null : count((r) => r.stage === 'pending'),
    retry: cardsUnknown ? null : count((r) => r.flags.includes('retry_queued')),
    error: cardsUnknown ? null : count((r) => r.flags.includes('card_error')),
    closedWithoutMemo: memoUnknown ? null : count((r) => r.stage === 'closed_without_memo'),
  };

  return {
    capturedAt: typeof snapshot.capturedAt === 'string' ? snapshot.capturedAt : null,
    scope: typeof snapshot.scope === 'string' ? snapshot.scope : null,
    cohortDefinition: COHORT_DEFINITION,
    counts,
    rows,
    limitations: [...LIMITATIONS],
    evidenceErrors,
  };
}
