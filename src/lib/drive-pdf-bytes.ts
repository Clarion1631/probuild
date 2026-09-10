export type VerifiedPdf = {
  kind: 'verified';
  id: string;
  sha256: string;
  version: string;
  byteLength: number;
};

export type PdfByteResult =
  | VerifiedPdf
  | { kind: 'unavailable'; reason: UnavailableReason };

export type UnavailableReason =
  | 'invalid_file_id'
  | 'metadata_rejected'
  | 'metadata_changed'
  | 'content_rejected'
  | 'timeout'
  | 'provider_error';

export interface DriveFileMetadata {
  id?: string | null;
  mimeType?: string | null;
  trashed?: boolean | null;
  version?: string | null;
  size?: string | null;
}

export interface DrivePdfDeps {
  metadata(): Promise<DriveFileMetadata>;
  chunks(): AsyncIterable<Uint8Array>;
}

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const ABSOLUTE_DEADLINE_MS = 20_000;

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const PDF_MIME = 'application/pdf';
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

class DeadlineError extends Error {
  constructor() {
    super('deadline');
    this.name = 'DeadlineError';
  }
}

interface NormalizedMetadata {
  id: string;
  mimeType: string;
  trashed: boolean;
  version: string;
  size: number;
}

/**
 * Pure, dependency-injected verifier for a Google Drive PDF.
 *
 * Note for the real Google API adapter: in addition to this function's
 * internal per-operation timers, the adapter should pass its own
 * AbortSignal (e.g. AbortSignal.timeout) to fetch so that hung sockets
 * are torn down independently of the generator's return() best effort.
 */
export async function verifyBoundedPdf(
  fileId: string,
  deps: DrivePdfDeps,
): Promise<PdfByteResult> {
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) {
    return unavailable('invalid_file_id');
  }

  const deadlineAt = Date.now() + ABSOLUTE_DEADLINE_MS;
  const remaining = (): number => deadlineAt - Date.now();

  const withDeadline = <T>(factory: () => Promise<T>): Promise<T> => {
    const ms = remaining();
    if (ms <= 0) return Promise.reject(new DeadlineError());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError()), ms);
    });
    return Promise.race([factory(), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };

  let iterator: AsyncIterator<Uint8Array> | undefined;
  let timedOut = false;

  try {
    const before = normalizeMetadata(await withDeadline(() => deps.metadata()));
    if (before === null || before.id !== fileId) {
      return unavailable('metadata_rejected');
    }

    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    const expected = before.size;
    let total = 0;
    let prefixSeen = 0;
    let contentOk = true;

    iterator = deps.chunks()[Symbol.asyncIterator]();

    for (;;) {
      const step = await withDeadline(() => iterator!.next());
      if (step.done) break;
      const chunk = step.value;
      if (!(chunk instanceof Uint8Array)) {
        contentOk = false;
        break;
      }

      total += chunk.byteLength;
      if (total > expected || total > MAX_PDF_BYTES) {
        contentOk = false;
        break;
      }

      for (let i = 0; prefixSeen < PDF_MAGIC.length && i < chunk.byteLength; i++, prefixSeen++) {
        if (chunk[i] !== PDF_MAGIC[prefixSeen]) {
          contentOk = false;
          break;
        }
      }
      if (!contentOk) break;

      hash.update(chunk);
    }

    await closeIterator(iterator, withDeadline);
    iterator = undefined;

    if (!contentOk || total !== expected || prefixSeen < PDF_MAGIC.length) {
      return unavailable('content_rejected');
    }

    const after = normalizeMetadata(await withDeadline(() => deps.metadata()));
    if (after === null || !metadataEqual(before, after)) {
      return unavailable('metadata_changed');
    }

    return {
      kind: 'verified',
      id: before.id,
      sha256: hash.digest('hex'),
      version: before.version,
      byteLength: total,
    };
  } catch (err) {
    timedOut = err instanceof DeadlineError;
    return unavailable(timedOut ? 'timeout' : 'provider_error');
  } finally {
    if (iterator !== undefined) {
      // Best effort: do not await a possibly hung return().
      const it = iterator;
      try {
        void Promise.resolve(it.return?.()).catch(() => undefined);
      } catch {
        // ignore
      }
    }
  }
}

async function closeIterator(
  iterator: AsyncIterator<Uint8Array>,
  withDeadline: <T>(factory: () => Promise<T>) => Promise<T>,
): Promise<void> {
  if (typeof iterator.return !== 'function') return;
  try {
    await withDeadline(() => Promise.resolve(iterator.return!()));
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    // Non-deadline errors from return() are ignored; bytes were already validated.
  }
}

function normalizeMetadata(raw: DriveFileMetadata | null | undefined): NormalizedMetadata | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { id, mimeType, trashed, version, size } = raw;
  if (typeof id !== 'string' || !FILE_ID_PATTERN.test(id)) return null;
  if (mimeType !== PDF_MIME) return null;
  if (trashed !== false) return null;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof size !== 'string' || !/^[0-9]{1,16}$/.test(size)) return null;
  const sizeNum = Number(size);
  if (!Number.isSafeInteger(sizeNum) || sizeNum <= 0 || sizeNum > MAX_PDF_BYTES) return null;
  return { id, mimeType, trashed, version, size: sizeNum };
}

function metadataEqual(a: NormalizedMetadata, b: NormalizedMetadata): boolean {
  return (
    a.id === b.id &&
    a.mimeType === b.mimeType &&
    a.trashed === b.trashed &&
    a.version === b.version &&
    a.size === b.size
  );
}

function unavailable(reason: UnavailableReason): PdfByteResult {
  return { kind: 'unavailable', reason };
}