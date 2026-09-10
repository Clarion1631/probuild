export type MemoArtifact = {
  id: string;
  pdfId: string;
  pdfSha256: string | null;
  targetType: string;
  targetKey: string;
  issueId: string;
};

export type MemoContentTx = {
  receiptMemoArtifact: {
    findMany(args: {
      where?: Record<string, unknown>;
      take?: number;
      select?: Record<string, boolean>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }): Promise<Partial<MemoArtifact>[]>;
    count(args: { where?: Record<string, unknown> }): Promise<number>;
  };
};

export type MemoContentInput = {
  pdfId: string;
  pdfSha256: string;
  targetType: string;
  targetKey: string;
  issueId: string;
};

export type MemoContentVerdict =
  | { kind: 'new' }
  | { kind: 'same'; hashVerified: boolean }
  | { kind: 'conflict'; reason: string }
  | {
      kind: 'incomplete';
      reason: 'hashless-bindings';
      unknownCount: number;
      unknownPdfIds: string[];
      truncated: boolean;
    };

const HASH_RE = /^[0-9a-f]{64}$/;
const FILE_ID_RE = /^[A-Za-z0-9._~-]{1,200}$/;
const HASHLESS_CAP = 20;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function conflict(reason: string): MemoContentVerdict {
  return { kind: 'conflict', reason };
}

export async function inspectMemoContentBinding(
  tx: MemoContentTx,
  input: MemoContentInput,
): Promise<MemoContentVerdict> {
  if (!input || typeof input !== 'object') return conflict('invalid input: hash and ids required');
  const { pdfId, pdfSha256, targetType, targetKey, issueId } = input;
  if (typeof pdfSha256 !== 'string' || !HASH_RE.test(pdfSha256)) {
    return conflict('invalid pdfSha256: hash must be 64 lowercase hex characters');
  }
  if (!isNonEmptyString(pdfId) || !FILE_ID_RE.test(pdfId)) {
    return conflict('invalid pdfId: must be a url-safe file id (1..200 chars)');
  }
  if (!isNonEmptyString(targetType)) return conflict('invalid targetType: required string');
  if (!isNonEmptyString(targetKey)) return conflict('invalid targetKey: required string');
  if (!isNonEmptyString(issueId)) return conflict('invalid issueId: required string');

  const related = (await tx.receiptMemoArtifact.findMany({
    where: {
      OR: [
        { pdfId },
        { AND: [{ targetType }, { targetKey }] },
        { pdfSha256: { equals: pdfSha256 } },
      ],
    },
    take: 4,
    select: { id: true, pdfId: true, pdfSha256: true, targetType: true, targetKey: true, issueId: true },
  })) as MemoArtifact[];

  if (related.length > 3) return conflict('artifact binding inventory inconsistent');
  if (related.some(r => r.pdfSha256 === pdfSha256 && (r.pdfId !== pdfId || r.targetType !== targetType || r.targetKey !== targetKey || r.issueId !== issueId))) return conflict('content hash already bound to another artifact, target or issue');
  const samePdf = related.filter((r) => r.pdfId === pdfId);
  const exact = samePdf.filter(
    (r) => r.targetType === targetType && r.targetKey === targetKey && r.issueId === issueId,
  );

  if (exact.length > 0) {
    if (exact.some((r) => r.pdfSha256 === pdfSha256)) return { kind: 'same', hashVerified: true };
    const mismatched = exact.filter((r) => r.pdfSha256 !== null && r.pdfSha256 !== pdfSha256);
    if (mismatched.length > 0) {
      return conflict(
        `hash mismatch: pdf ${pdfId} already bound to target ${targetType}/${targetKey} with a different content hash`,
      );
    }
    return { kind: 'same', hashVerified: false };
  }

  if (samePdf.length > 0) {
    const r = samePdf[0];
    const diffs: string[] = [];
    if (r.targetType !== targetType) diffs.push(`targetType (${r.targetType} != ${targetType})`);
    if (r.targetKey !== targetKey) diffs.push(`targetKey (${r.targetKey} != ${targetKey})`);
    if (r.issueId !== issueId) diffs.push(`issueId (${r.issueId} != ${issueId})`);
    return conflict(`pdf ${pdfId} already bound to a different target: ${diffs.join(', ')}`);
  }

  const sameTarget = related.find((r) => r.targetType === targetType && r.targetKey === targetKey);
  if (sameTarget) {
    return conflict(
      `target ${targetType}/${targetKey} already bound to a different pdf (${sameTarget.pdfId})`,
    );
  }

  const sameHash = related.find((r) => r.pdfSha256 === pdfSha256);
  if (sameHash) {
    return conflict(`content hash already bound to a different pdf (${sameHash.pdfId})`);
  }

  const unknownCount = await tx.receiptMemoArtifact.count({ where: { pdfSha256: null } });
  if (!Number.isSafeInteger(unknownCount) || unknownCount < 0) return conflict('invalid hashless artifact count');
  if (unknownCount > 0) {
    const hashless = (await tx.receiptMemoArtifact.findMany({
      where: { pdfSha256: null },
      orderBy: { pdfId: 'asc' },
      take: HASHLESS_CAP,
      select: { pdfId: true },
    })) as { pdfId: string }[];
    if (hashless.length !== Math.min(unknownCount, HASHLESS_CAP) || hashless.some(h => typeof h.pdfId !== 'string' || !h.pdfId)) return conflict('incomplete hashless artifact inventory');
    const unknownPdfIds = Array.from(new Set(hashless.map((h) => h.pdfId))).sort();
    return {
      kind: 'incomplete',
      reason: 'hashless-bindings',
      unknownCount,
      unknownPdfIds,
      truncated: unknownCount > unknownPdfIds.length,
    };
  }

  return { kind: 'new' };
}