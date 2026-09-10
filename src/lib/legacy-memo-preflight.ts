const LIST_BOUND = 20;
const RETRY_AFTER_SECONDS = '30';

export type LegacyMemoArtifactRow = {
  pdfId: string;
  targetType: string;
  targetKey: string;
  issueId: string;
};

export type LegacyMemoArtifactSelect = {
  pdfId: true;
  targetType: true;
  targetKey: true;
  issueId: true;
};

export type LegacyMemoArtifactFindManyArgs = {
  orderBy: { pdfId: 'asc' };
  take: number;
  select: LegacyMemoArtifactSelect;
};

export type LegacyMemoPreflightDb = {
  receiptMemoArtifact: {
    count: () => Promise<number>;
    findMany: (args: LegacyMemoArtifactFindManyArgs) => Promise<LegacyMemoArtifactRow[]>;
  };
};

export type LegacyMemoPreflightDeps = {
  authorized: (request: Request) => boolean;
  now: () => Date;
  db: LegacyMemoPreflightDb;
};

export type LegacyMemoPreflightResponseBody = {
  artifactCount: number;
  artifacts: LegacyMemoArtifactRow[];
  truncated: boolean;
  contentVerifiedCount: null;
  hashFieldsQueried: false;
  businessWrites: false;
  observedAt: string;
  inventoryConsistency: 'observed-nontransactional';
  note: string;
};

export type LegacyMemoPreflightHandler = (req: Request) => Promise<Response>;

const OBSERVATION_NOTE =
  'Metadata inventory only. Counts and listing are non-transactional observations; concurrent writes can follow this observation. Count is not eligible as content verification.';

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function unavailable(reason: 'unavailable' | 'incomplete'): Response {
  return jsonResponse(
    503,
    { error: 'service_unavailable', status: reason },
    { 'retry-after': RETRY_AFTER_SECONDS },
  );
}

export function createLegacyMemoPreflightHandler(deps: LegacyMemoPreflightDeps): LegacyMemoPreflightHandler {
  const { authorized, now, db } = deps;

  return async function legacyMemoPreflightHandler(req: Request): Promise<Response> {
    if (authorized(req) !== true) {
      return jsonResponse(401, { error: 'unauthorized' });
    }

    if (req.method !== 'GET') {
      return jsonResponse(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    }

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return jsonResponse(400, { error: 'bad_request' });
    }

    if (url.search !== '') {
      return jsonResponse(400, { error: 'query_parameters_not_permitted' });
    }

    let countBefore: number;
    let rows: LegacyMemoArtifactRow[];
    let countAfter: number;

    try {
      countBefore = await db.receiptMemoArtifact.count();
      rows = await db.receiptMemoArtifact.findMany({
        orderBy: { pdfId: 'asc' },
        take: LIST_BOUND,
        select: { pdfId: true, targetType: true, targetKey: true, issueId: true },
      });
      countAfter = await db.receiptMemoArtifact.count();
    } catch {
      return unavailable('unavailable');
    }

    if (
      !Number.isSafeInteger(countBefore) ||
      !Number.isSafeInteger(countAfter) ||
      countBefore < 0 ||
      countAfter < 0 ||
      !Array.isArray(rows)
    ) {
      return unavailable('unavailable');
    }

    if (countBefore !== countAfter || rows.length !== Math.min(countAfter, LIST_BOUND)) {
      return unavailable('incomplete');
    }

    if (rows.some(row => !row || [row.pdfId, row.targetType, row.targetKey, row.issueId].some(value => typeof value !== 'string' || !value)) || new Set(rows.map(row => row.pdfId)).size !== rows.length) return unavailable('incomplete');

    const artifacts: LegacyMemoArtifactRow[] = rows.slice(0, LIST_BOUND).map((row) => ({
      pdfId: String(row.pdfId),
      targetType: String(row.targetType),
      targetKey: String(row.targetKey),
      issueId: String(row.issueId),
    }));

    const body: LegacyMemoPreflightResponseBody = {
      artifactCount: countAfter,
      artifacts,
      truncated: countAfter > artifacts.length,
      contentVerifiedCount: null,
      hashFieldsQueried: false,
      businessWrites: false,
      observedAt: now().toISOString(),
      inventoryConsistency: 'observed-nontransactional',
      note: OBSERVATION_NOTE,
    };

    return jsonResponse(200, body);
  };
}