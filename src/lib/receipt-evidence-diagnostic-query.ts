export const DIAGNOSTIC_ACCOUNT = 'WTB-0723';
export const MAX_DIAGNOSTIC_IDS = 10;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const QB_ID_RE = /^[0-9]{1,20}$/;
const ALLOWED_KEYS = new Set(['bankLineIds', 'qbTxnIds']);

function parseIdList(raw: string, pattern: RegExp, normalize: (id: string) => string): string[] | null {
  if (raw === '') return null;
  const ids = raw.split(',');
  if (ids.length > MAX_DIAGNOSTIC_IDS) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!pattern.test(id)) return null;
    const normalized = normalize(id);
    if (seen.has(normalized)) return null;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseReceiptEvidenceQuery(params: URLSearchParams): { bankLineIds: string[]; qbTxnIds: string[] } | null {
  for (const key of params.keys()) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }
  const bankRaw = params.getAll('bankLineIds');
  if (bankRaw.length !== 1) return null;
  const bankLineIds = parseIdList(bankRaw[0], UUID_RE, (id) => id.toLowerCase());
  if (bankLineIds === null) return null;
  const qbRaw = params.getAll('qbTxnIds');
  if (qbRaw.length > 1) return null;
  let qbTxnIds: string[] = [];
  if (qbRaw.length === 1) {
    const parsed = parseIdList(qbRaw[0], QB_ID_RE, (id) => id);
    if (parsed === null) return null;
    qbTxnIds = parsed;
  }
  return { bankLineIds, qbTxnIds };
}
