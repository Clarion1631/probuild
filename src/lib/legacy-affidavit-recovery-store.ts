import { parseRecoveryDisplayDetails } from './legacy-affidavit-recovery-service';
import { bumpReceiptEvidenceEpoch } from './receipt-evidence-lock';
import type { Prisma } from '@prisma/client';
import { stableRecoveryDigest, legacyDescriptorIdentity, type Packet } from './legacy-affidavit-recovery-proof';
import type { RecoveryRecord, RecoverySnapshot, SnapshotArtifact } from './legacy-affidavit-recovery-service';

/**
 * Prisma 5 runtime adapter for legacy affidavit recovery.
 *
 * Ownership rules:
 *  - No $transaction is opened here. The calling service owns the transaction and acquires
 *    the receiptEvidence -> bankIdentity -> content hash -> PDF locks before writeRecovery.
 *  - loadRecoverySnapshot runs unlocked in prepare mode and is observation-only; the unknown
 *    artifact count may change before it returns. The in-transaction re-read (service side)
 *    plus the version CAS in writeRecovery protect apply.
 *  - Every query is keyed off packet.target (bankLineId / account) or the packet pdf. No
 *    caller-supplied free-form filters are ever passed to the database.
 *  - No QBO, ProBuild expense, payment, Chat or Drive writes, and no provider reads.
 */

export type RecoveryDb = Pick<
  Prisma.TransactionClient,
  'bankLine' | 'receiptMemoArtifact' | 'reviewIssue' | 'reviewAlertEpisode' | '$queryRaw' | '$executeRaw'
>;

const TARGET_TYPE = 'bank-line' as const;
const MEMO_SIGNED = 'memo-signed' as const;
const OBSERVATION_LIMIT = 10;
const ARTIFACT_LIMIT = 4;
const UNKNOWN_LIST_LIMIT = 20;
const COMPETING_LIMIT = 100;
const REUSE_LIMIT = 20;
const CANCELLABLE_EPISODE_STATUSES = ['PENDING', 'CLAIMED', 'BATCHED', 'FAILED'] as const;

const canonicalSelect = {
  id: true,
  account: true,
  postedDate: true,
  rawDescriptor: true,
  amountCents: true,
  sourceOfRecord: true,
  state: true,
  qbTxnId: true,
  probuildExpenseId: true,
  updatedAt: true,
} satisfies Prisma.BankLineSelect;

const observationSelect = {
  id: true,
  account: true,
  source: true,
  sourceDocumentId: true,
  sourceLineId: true,
  postedDate: true,
  amountCents: true,
  rawDescriptor: true,
  statementImport: {
    select: {
      id: true,
      account: true,
      status: true,
      periodStart: true,
      periodEnd: true,
      openingCents: true,
      closingCents: true,
      contentHash: true,
    },
  },
} satisfies Prisma.BankLineObservationSelect;

const artifactSelect = {
  pdfId: true,
  pdfSha256: true,
  targetType: true,
  targetKey: true,
  issueId: true,
  provenanceJson: true,
} satisfies Prisma.ReceiptMemoArtifactSelect;

const issueSelect = {
  id: true,
  version: true,
  displayDetails: true,
  clearedAt: true,
  acknowledgedCodes: true,
  acknowledgedAt: true,
  updatedAt: true,
} satisfies Prisma.ReviewIssueSelect;

function matchesTarget(identity: ReturnType<typeof legacyDescriptorIdentity>, target: Packet['target']): boolean {
  return (
    identity !== null &&
    identity.cardLast4 === target.cardLast4 &&
    identity.purchaseIso === target.purchaseDate &&
    identity.reference === target.bankReference
  );
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function loadRecoverySnapshot(db: RecoveryDb, packet: Packet): Promise<RecoverySnapshot> {
  const { target, pdf } = packet;
  const line = await db.bankLine.findUnique({
    where: { id: target.bankLineId },
    select: {
      ...canonicalSelect,
      observations: {
        where: { source: 'STATEMENT', account: target.account },
        orderBy: { id: 'asc' },
        take: OBSERVATION_LIMIT + 1,
        select: observationSelect,
      },
    },
  });
  if (!line) throw new Error(`recovery target bank line not found: ${target.bankLineId}`);
  if (line.account !== target.account) throw new Error('recovery target account mismatch');
  const { observations, ...fields } = line;
  const canonical = jsonSafe({
    ...fields,
    observationsTruncated: observations.length > OBSERVATION_LIMIT,
    observations: observations.slice(0, OBSERVATION_LIMIT),
  });

  const issue = await db.reviewIssue.findUnique({
    where: { targetType_targetKey: { targetType: TARGET_TYPE, targetKey: target.bankLineId } },
    select: issueSelect,
  });
  if (!issue) throw new Error(`review issue not found for bank line ${target.bankLineId}`);

  const artifacts: SnapshotArtifact[] = await db.receiptMemoArtifact.findMany({
    where: {
      OR: [
        { pdfId: pdf.id },
        { pdfSha256: pdf.sha256 },
        { targetType: TARGET_TYPE, targetKey: target.bankLineId },
      ],
    },
    orderBy: { id: 'asc' },
    take: ARTIFACT_LIMIT,
    select: artifactSelect,
  });

  const unknownWhere = {
    pdfSha256: null,
  } satisfies Prisma.ReceiptMemoArtifactWhereInput;
  const unknownCount = await db.receiptMemoArtifact.count({ where: unknownWhere });
  const unknownRows = await db.receiptMemoArtifact.findMany({
    where: unknownWhere,
    orderBy: { id: 'asc' },
    take: UNKNOWN_LIST_LIMIT,
    select: { pdfId: true },
  });

  // Competing bank lines: same account/amount and descriptor carrying the bank reference.
  // Intentionally no date filter so older hidden duplicates are not excluded.
  const competing = await db.bankLine.findMany({
    where: {
      account: target.account,
      amountCents: target.amountCents,
      rawDescriptor: { contains: target.bankReference },
    },
    orderBy: { id: 'asc' },
    take: COMPETING_LIMIT + 1,
    select: { id: true, rawDescriptor: true },
  });
  const competingTruncated = competing.length > COMPETING_LIMIT;
  const targetIdentityOk = matchesTarget(legacyDescriptorIdentity(line.rawDescriptor), target);
  const identityDuplicate = competing.some(
    (c) => c.id !== line.id && matchesTarget(legacyDescriptorIdentity(c.rawDescriptor), target),
  );

  // Legacy displayDetails reuse: another issue already claims this pdf as memo-signed.
  const reuse = await db.reviewIssue.findMany({
    where: {
      targetType: TARGET_TYPE,
      targetKey: { not: target.bankLineId },
      displayDetails: { contains: pdf.id },
    },
    orderBy: { id: 'asc' },
    take: REUSE_LIMIT + 1,
    select: { displayDetails: true },
  });
  const reuseTruncated = reuse.length > REUSE_LIMIT;
  const reuseClaim = reuse.slice(0, REUSE_LIMIT).some((r) => {
    if (!r.displayDetails) return false;
    try {
      const parsed = JSON.parse(r.displayDetails) as unknown;
      if (!parsed || typeof parsed !== 'object') return false;
      const d = parsed as Record<string, unknown>;
      return d.pdfId === pdf.id && d.resolution === MEMO_SIGNED;
    } catch {
      return false;
    }
  });

  const truncated = competingTruncated || reuseTruncated || artifacts.length >= ARTIFACT_LIMIT;
  return {
    canonical,
    issue: jsonSafe(issue),
    artifacts,
    unknownArtifacts: {
      count: unknownCount,
      pdfIds: unknownRows.map((r) => r.pdfId),
      truncated: unknownCount > UNKNOWN_LIST_LIMIT,
    },
    // Uniqueness is never claimed when the competing scan was capped.
    identityConflict: !targetIdentityOk || identityDuplicate || competingTruncated || reuseClaim,
    truncated,
  };
}


/** Writes a strictly NEW artifact. The service guarantees no existing artifact and holds all locks. */
export async function writeRecovery(tx: RecoveryDb, record: RecoveryRecord): Promise<void> {
  const { snapshot, packet, pdf, planDigest, recoveredAt, recoveredBy } = record;
  const now = new Date();
  const recoveredAtDate = new Date(recoveredAt);
  const original = parseRecoveryDisplayDetails(snapshot.issue.displayDetails);
  const displayDetails = JSON.stringify({
    ...original, // preserves all existing cards/fields; no card or forwarder ACK is ever added
    resolution: MEMO_SIGNED,
    pdfId: pdf.id,
    pdfUrl: `https://drive.google.com/file/d/${pdf.id}/view`,
    signedAt: packet.legacy.signedAtVerbatim,
    signedThread: packet.originalHuman.thread,
  });
  const provenanceJson = JSON.stringify({
    version: 1,
    kind: 'admin-attested-legacy-recovery',
    chatVerification: 'admin-attested-provider-packet',
    packetDigest: stableRecoveryDigest(packet),
    packet, // immutable original packet
    approvingAdmin: packet.approvingAdmin,
    planDigest,
    recoveredAt,
    recoveredBy,
    pdf: { id: pdf.id, sha256: pdf.sha256, version: pdf.version, byteLength: pdf.byteLength },
  });

  // Epoch bump precedes the issue row mutation so concurrent evidence readers invalidate first.
  await bumpReceiptEvidenceEpoch(tx);

  const cas = await tx.reviewIssue.updateMany({
    where: { id: snapshot.issue.id, version: snapshot.issue.version },
    data: {
      version: { increment: 1 },
      displayDetails,
      clearedAt: recoveredAtDate,
      acknowledgedCodes: '[]',
      acknowledgedAt: null,
      updatedAt: now,
    },
  });
  if (cas.count !== 1) {
    throw new Error(`review issue CAS failed for ${snapshot.issue.id}@${snapshot.issue.version}`);
  }

  await tx.receiptMemoArtifact.create({
    data: {
      pdfId: pdf.id,
      pdfSha256: pdf.sha256,
      targetType: TARGET_TYPE,
      targetKey: packet.target.bankLineId,
      issueId: snapshot.issue.id,
      provenanceJson,
    },
  });

  await tx.reviewAlertEpisode.updateMany({
    where: { issueId: snapshot.issue.id, status: { in: [...CANCELLABLE_EPISODE_STATUSES] } },
    data: { status: 'CANCELLED' },
  });
}