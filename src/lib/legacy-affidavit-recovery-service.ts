import { sanitizeProbeDiagnostic, type PdfProbeDiagnostic } from './drive-pdf-probe';
import {
  validateLegacyRecoveryProof,
  stableRecoveryDigest,
  type Packet,
} from './legacy-affidavit-recovery-proof';

export type RecoveryMode = 'prepare' | 'apply';
export type RecoveryStatus = 'ready' | 'recovered' | 'already-recovered' | 'conflict' | 'incomplete' | 'rejected';

export interface RecoveryRequest {
  mode: RecoveryMode;
  bankLineId: string;
  planDigest?: string;
}

export interface RecoveryDiagnostics {
  unknownCount: number;
  pdfIds: string[];
  truncated: boolean;
}

export interface RecoveryResult {
  ok: boolean;
  status: RecoveryStatus;
  planDigest?: string;
  reason?: string;
  capturedAt?: string;
  diagnostics?: RecoveryDiagnostics;
  pdfDiagnostic?: PdfProbeDiagnostic;
}

export interface SnapshotArtifact {
  pdfId: string;
  pdfSha256: string | null;
  targetType: string;
  targetKey: string;
  issueId: string;
  provenanceJson: string | null;
}

export interface RecoverySnapshot {
  canonical: unknown;
  issue: { id: string; version: number; displayDetails: string | null };
  artifacts: SnapshotArtifact[];
  unknownArtifacts: { count: number; pdfIds: string[]; truncated: boolean };
  identityConflict: boolean;
  truncated: boolean;
}

export type DriveResult =
  | { kind: 'verified'; id: string; sha256: string; version: string; byteLength: number }
  | { kind: 'unavailable'; reason: string; diagnostic?: unknown };

export interface VerifiedPdf {
  id: string;
  sha256: string;
  version: string;
  byteLength: number;
}

export interface RecoveryRecord {
  snapshot: RecoverySnapshot;
  packet: Packet;
  pdf: VerifiedPdf;
  planDigest: string;
  recoveredAt: string;
  recoveredBy: 'cron-machine';
}

export interface RecoveryTx {
  snapshot(bankLineId: string): Promise<RecoverySnapshot>;
  lockEvidence(): Promise<void>;
  lockBankIdentity(): Promise<void>;
  lockContent(sha256: string): Promise<void>;
  lockPdf(pdfId: string): Promise<void>;
  writeRecovery(record: RecoveryRecord): Promise<void>;
}

export interface RecoveryDeps {
  /** Returns the admin-pinned packet and its semantically stable digest; throws on pin mismatch. */
  packet(): Promise<{ packet: Packet; packetDigest: string }>;
  drive(pdfId: string): Promise<DriveResult>;
  snapshot(bankLineId: string): Promise<RecoverySnapshot>;
  transaction<T>(fn: (tx: RecoveryTx) => Promise<T>): Promise<T>;
  now(): Date;
}

const RECOVERED_BY = 'cron-machine' as const;
const TARGET_TYPE = 'bank-line';
const PLAN_VERSION = 1;

type Analysis =
  | { verdict: 'ok'; planDigest: string }
  | { verdict: 'already-recovered' }
  | { verdict: 'fail'; result: RecoveryResult };

function planDigestOf(packetDigest: string, pdf: VerifiedPdf, snapshot: RecoverySnapshot): string {
  const plan = {
    version: PLAN_VERSION,
    packetDigest,
    pdf: { id: pdf.id, sha256: pdf.sha256, version: pdf.version, byteLength: pdf.byteLength },
    snapshot,
  };
  return stableRecoveryDigest(plan);
}

function failure(status: RecoveryStatus, reason: string, diagnostics?: RecoveryDiagnostics): Analysis {
  return { verdict: 'fail', result: { ok: false, status, reason, ...(diagnostics ? { diagnostics } : {}) } };
}

function verifyDrive(drive: DriveResult, packet: Packet): VerifiedPdf | string {
  if (drive.kind !== 'verified') return `pdf unavailable: ${drive.reason}`;
  if (drive.id !== packet.pdf.id) return `pdf id mismatch: drive ${drive.id} vs packet ${packet.pdf.id}`;
  if (drive.sha256 !== packet.pdf.sha256) return `pdf sha256 mismatch: drive ${drive.sha256} vs packet ${packet.pdf.sha256}`;
  if (typeof drive.version !== 'string' || drive.version.length === 0) return 'pdf drive version missing';
  if (!Number.isInteger(drive.byteLength) || drive.byteLength <= 0) return 'pdf drive byteLength invalid';
  return { id: drive.id, sha256: drive.sha256, version: drive.version, byteLength: drive.byteLength };
}

function parseProvenance(json: string | null): { recoveredBy?: unknown; packetDigest?: unknown } | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { recoveredBy?: unknown; packetDigest?: unknown })
      : {};
  } catch {
    return {};
  }
}

export function parseRecoveryDisplayDetails(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as unknown; // malformed JSON throws by design
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('review issue displayDetails is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}


function analyze(
  bankLineId: string,
  packet: Packet,
  packetDigest: string,
  pdf: VerifiedPdf,
  snapshot: RecoverySnapshot,
): Analysis {
  const unknown = snapshot?.unknownArtifacts;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500;
  if (!snapshot || typeof snapshot.identityConflict !== 'boolean' || typeof snapshot.truncated !== 'boolean'
      || !Array.isArray(snapshot.artifacts) || snapshot.artifacts.length > 4 || !unknown
      || !Number.isSafeInteger(unknown.count) || unknown.count < 0
      || typeof unknown.truncated !== 'boolean' || !Array.isArray(unknown.pdfIds)
      || unknown.pdfIds.length > 20 || unknown.pdfIds.some(v => !str(v))
      || new Set(unknown.pdfIds).size !== unknown.pdfIds.length
      || unknown.count < unknown.pdfIds.length
      || unknown.truncated !== (unknown.count > unknown.pdfIds.length)) return failure('rejected', 'malformed snapshot inventory');
  if (!str(snapshot.issue?.id) || !Number.isSafeInteger(snapshot.issue?.version)
      || snapshot.issue.version < 1 || snapshot.issue.version > 2147483647) return failure('rejected', 'malformed issue version');
  try { parseRecoveryDisplayDetails(snapshot.issue.displayDetails); }
  catch { return failure('rejected', 'malformed issue displayDetails'); }
  if (snapshot.artifacts.some(a => !a || ![a.pdfId,a.targetType,a.targetKey,a.issueId].every(str)
      || (a.pdfSha256 !== null && (typeof a.pdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.pdfSha256)))
      || (a.provenanceJson !== null && typeof a.provenanceJson !== 'string'))) return failure('rejected','malformed artifact');
  if (snapshot.identityConflict) return failure('conflict', 'competing bank identity for target');
  if (snapshot.truncated) return failure('conflict', 'snapshot truncated; refusing to reason about partial state');

  // Validate the original provenance against current canonical source evidence.
  const validation = validateLegacyRecoveryProof(packet, snapshot.canonical);
  if (!validation.ok) return failure('rejected', `proof rejected: ${validation.reason}`);
  const proof = validation.proof;
  if (proof.bankLineId !== bankLineId) return failure('conflict', 'proof target does not match requested bank line');
  if (proof.pdfId !== pdf.id || proof.pdfSha256 !== pdf.sha256) return failure('conflict', 'proof pdf/sha256 does not match drive');
  if (proof.packetDigest !== packetDigest) return failure('conflict', 'proof packetDigest does not match packet digest');

  let alreadyRecovered = false;
  let hashlessBinding = false;
  for (const a of snapshot.artifacts) {
    const samePdf = a.pdfId === pdf.id;
    const sameHash = a.pdfSha256 !== null && a.pdfSha256 === pdf.sha256;
    const sameTarget = a.targetKey === bankLineId;
    if (!samePdf && !sameHash && !sameTarget) continue;
    if (!samePdf) {
      if (sameHash) return failure('conflict', `content sha256 already bound to another pdf ${a.pdfId}`);
      return failure('conflict', `target already bound to another pdf ${a.pdfId}`);
    }
    if (a.targetType !== TARGET_TYPE || a.targetKey !== bankLineId || a.issueId !== snapshot.issue.id) {
      return failure('conflict', `existing artifact bound to wrong target ${a.targetType}:${a.targetKey}`);
    }
    if (a.pdfSha256 === null) {
      hashlessBinding = true;
      continue;
    }
    if (a.pdfSha256 !== pdf.sha256) return failure('conflict', 'existing artifact sha256 differs from drive hash');
    const prov = parseProvenance(a.provenanceJson);
    if (prov === null) return failure('conflict', 'existing normal binding without recovery provenance');
    if (prov.recoveredBy !== RECOVERED_BY) return failure('conflict', 'existing binding carries foreign provenance');
    if (prov.packetDigest !== packetDigest) return failure('conflict', 'existing recovery names a different packetDigest');
    alreadyRecovered = true;
  }
  if (alreadyRecovered) return { verdict: 'already-recovered' };

  const diagnostics: RecoveryDiagnostics = {
    unknownCount: unknown.count,
    pdfIds: [...unknown.pdfIds],
    truncated: unknown.truncated,
  };
  if (hashlessBinding) return failure('incomplete', 'existing binding has no sha256', diagnostics);
  if (unknown.count > 0 || unknown.truncated || unknown.pdfIds.length > 0) {
    return failure('incomplete', 'unknown artifacts present', diagnostics);
  }
  return { verdict: 'ok', planDigest: planDigestOf(packetDigest, pdf, snapshot) };
}

export function createLegacyRecoveryService(deps: RecoveryDeps): { handle(req: RecoveryRequest): Promise<RecoveryResult> } {
  async function handle(req: RecoveryRequest): Promise<RecoveryResult> {
    if (!req || (req.mode !== 'prepare' && req.mode !== 'apply')) return { ok: false, status: 'rejected', reason: 'invalid mode' };
    const bankLineId = req.bankLineId;
    if (typeof bankLineId !== 'string' || bankLineId.length === 0) return { ok: false, status: 'rejected', reason: 'invalid bankLineId' };

    // Fresh reads on every call; dependency errors propagate.
    const { packet, packetDigest } = await deps.packet();
    if (stableRecoveryDigest(packet) !== packetDigest) return { ok: false, status: 'rejected', reason: 'packetDigest does not match packet' };
    if (packet.target?.bankLineId !== bankLineId) return { ok: false, status: 'conflict', reason: 'packet target does not match requested bank line' };
    const driveResult = await deps.drive(packet.pdf.id);
    if (driveResult.kind === 'unavailable') return { ok: false, status: 'incomplete', reason: 'pdf unavailable',
      ...(req.mode === 'prepare' ? { pdfDiagnostic: sanitizeProbeDiagnostic(driveResult.diagnostic) } : {}),
    };
    const driveOut = verifyDrive(driveResult, packet);
    if (typeof driveOut === 'string') return { ok: false, status: 'conflict', reason: driveOut };
    const pdf = driveOut;
    const snapshot = await deps.snapshot(bankLineId);
    const fresh = analyze(bankLineId, packet, packetDigest, pdf, snapshot);
    if (fresh.verdict === 'fail') return fresh.result;
    if (fresh.verdict === 'already-recovered') return { ok: true, status: 'already-recovered' };

    if (req.mode === 'prepare') {
      return { ok: true, status: 'ready', planDigest: fresh.planDigest, capturedAt: deps.now().toISOString() };
    }
    const requested = req.planDigest;
    if (typeof requested !== 'string' || requested.length === 0) return { ok: false, status: 'rejected', reason: 'planDigest required for apply' };

    return deps.transaction(async (tx) => {
      if (requested !== fresh.planDigest) return { ok: false, status: 'conflict', reason: 'planDigest does not match current state' };
      await tx.lockEvidence();
      await tx.lockBankIdentity();
      await tx.lockContent(pdf.sha256);
      await tx.lockPdf(pdf.id);
      const locked = await tx.snapshot(bankLineId);
      const again = analyze(bankLineId, packet, packetDigest, pdf, locked);
      if (again.verdict === 'fail') return again.result;
      if (again.verdict === 'already-recovered') return { ok: true, status: 'already-recovered' };
      if (again.planDigest !== requested) return { ok: false, status: 'conflict', reason: 'state drifted inside transaction' };
      await tx.writeRecovery({
        snapshot: locked,
        packet,
        pdf,
        planDigest: requested,
        recoveredAt: deps.now().toISOString(),
        recoveredBy: RECOVERED_BY,
      });
      return { ok: true, status: 'recovered', planDigest: requested };
    });
  }
  return { handle };
}