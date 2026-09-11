import {
  verifyBoundedPdf,
  type DriveFileMetadata,
  type PdfByteResult,
  type UnavailableReason,
  type VerifiedPdf,
} from './drive-pdf-bytes';

/**
 * Bounded diagnostics wrapper around `verifyBoundedPdf`.
 *
 * This helper only observes. It never persists anything, never logs, and never
 * surfaces raw error messages, stack traces, credentials, URLs, or provider
 * payloads. The only external data it lets through is an integer HTTP status
 * in the range 100..599, and only when found on well-known error fields, plus
 * a provider error category coerced onto an exact closed enum.
 *
 */

export type AuthSource = 'token-file-or-env' | 'company-settings' | 'none' | 'unknown';

export type ProbePhase = 'input' | 'auth' | 'metadata-before' | 'media' | 'metadata-after';

/**
 * Closed enum of provider error categories. Only these exact strings are ever
 * returned; any other raw provider reason collapses to `unknown` and is never
 * echoed.
 */
export type ProviderCategory =
  | 'invalid_grant'
  | 'invalid_client'
  | 'access_denied'
  | 'insufficientPermissions'
  | 'notFound'
  | 'forbidden'
  | 'badRequest'
  | 'invalidParameter'
  | 'rateLimitExceeded'
  | 'userRateLimitExceeded'
  | 'backendError'
  | 'unknown';

export interface PdfProbeDiagnostic {
  reason: UnavailableReason;
  authSource: AuthSource;
  phase: ProbePhase;
  providerHttp: number | null;
  providerCategory: ProviderCategory;
}

export interface AuthStatus {
  ok: boolean;
  source: 'token-file-or-env' | 'company-settings' | 'none';
}

export interface DrivePdfProbeDeps {
  ensureAuth(): Promise<AuthStatus>;
  metadata(): Promise<DriveFileMetadata>;
  chunks(): AsyncIterable<Uint8Array>;
}

export type PdfProbeUnavailable = {
  kind: 'unavailable';
  reason: UnavailableReason;
  diagnostic: PdfProbeDiagnostic;
};

export type PdfProbeResult = VerifiedPdf | PdfProbeUnavailable;

const REASONS: readonly UnavailableReason[] = [
  'invalid_file_id',
  'metadata_rejected',
  'metadata_changed',
  'content_rejected',
  'timeout',
  'provider_error',
];

const AUTH_SOURCES: readonly AuthSource[] = ['token-file-or-env', 'company-settings', 'none', 'unknown'];

const PHASES: readonly ProbePhase[] = ['input', 'auth', 'metadata-before', 'media', 'metadata-after'];

// Known (non-fallback) categories. Raw reasons are matched by exact string
// equality only; no substring, message, or JSON parsing is performed.
const KNOWN_PROVIDER_CATEGORIES: readonly Exclude<ProviderCategory, 'unknown'>[] = [
  'invalid_grant',
  'invalid_client',
  'access_denied',
  'insufficientPermissions',
  'notFound',
  'forbidden',
  'badRequest',
  'invalidParameter',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
];

const PROVIDER_CATEGORIES: readonly ProviderCategory[] = [...KNOWN_PROVIDER_CATEGORIES, 'unknown'];

const FALLBACK_REASON: UnavailableReason = 'provider_error';
const FALLBACK_AUTH_SOURCE: AuthSource = 'unknown';
const FALLBACK_PHASE: ProbePhase = 'input';
const FALLBACK_PROVIDER_CATEGORY: ProviderCategory = 'unknown';

// Upper bound on how many entries of a provider `errors` array are inspected.
const MAX_REASON_ENTRIES = 10;

// Mirrors the verifier's private pattern so the ID can be rejected before any
// dependency (including ensureAuth) is touched. The verifier still re-checks.
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Extracts a safe HTTP status from an arbitrary thrown value. Only an integer
 * in 100..599 found at `response.status`, `status`, or `code` is returned.
 * Anything else yields `null`. The value itself is never retained.
 */
export function extractProviderHttp(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const response = e['response'];
  if (response !== null && typeof response === 'object') {
    const status = asHttpStatus((response as Record<string, unknown>)['status']);
    if (status !== null) return status;
  }
  const direct = asHttpStatus(e['status']);
  if (direct !== null) return direct;
  return asHttpStatus(e['code']);
}

/**
 * Extracts a bounded provider error category from an arbitrary thrown value.
 * Only three structured Google/Gaxios locations are consulted:
 *   - `response.data.error` when it is a string (OAuth token endpoint)
 *   - `response.data.error.errors[i].reason` when `error` is an object (API)
 *   - `errors[i].reason` on the error itself (flattened API details)
 * Arrays beyond `MAX_REASON_ENTRIES` fail closed to unknown. Raw
 * strings are matched by exact equality against the closed allowlist. If more
 * than one distinct known category is present the result is `unknown` rather
 * than a guessed priority. Messages, descriptions, and unknown reasons are
 * never read or echoed.
 */
export function extractProviderCategory(err: unknown): ProviderCategory {
  if (err === null || typeof err !== 'object') return FALLBACK_PROVIDER_CATEGORY;
  const e = err as Record<string, unknown>;
  const found = new Set<ProviderCategory>();
  let overflow = false;
  const collect = (list: unknown): void => {
    if (Array.isArray(list) && list.length > MAX_REASON_ENTRIES) { overflow = true; return; }
    considerReasons(list, consider);
  };
  const consider = (value: unknown): void => {
    if (isOneOf(KNOWN_PROVIDER_CATEGORIES, value)) found.add(value);
  };

  const response = e['response'];
  if (response !== null && typeof response === 'object') {
    const data = (response as Record<string, unknown>)['data'];
    if (data !== null && typeof data === 'object') {
      const error = (data as Record<string, unknown>)['error'];
      if (typeof error === 'string') {
        consider(error);
      } else if (error !== null && typeof error === 'object') {
        collect((error as Record<string, unknown>)['errors']);
      }
    }
  }

  collect(e['errors']);

  if (overflow || found.size !== 1) return FALLBACK_PROVIDER_CATEGORY;
  return found.values().next().value as ProviderCategory;
}

function considerReasons(list: unknown, consider: (value: unknown) => void): void {
  if (!Array.isArray(list)) return;
  const limit = Math.min(list.length, MAX_REASON_ENTRIES);
  for (let i = 0; i < limit; i += 1) {
    const entry: unknown = list[i];
    if (entry !== null && typeof entry === 'object') {
      consider((entry as Record<string, unknown>)['reason']);
    }
  }
}

function asHttpStatus(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < 100 || value > 599) return null;
  return value;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/**
 * Coerces an unknown external object into an exact, bounded diagnostic.
 * Unknown fields are dropped; invalid fields fall back to safe enum values or
 * `null`. Safe to return from a service layer without further filtering.
 */
export function sanitizeProbeDiagnostic(input: unknown): PdfProbeDiagnostic {
  const src = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    reason: isOneOf(REASONS, src['reason']) ? src['reason'] : FALLBACK_REASON,
    authSource: isOneOf(AUTH_SOURCES, src['authSource']) ? src['authSource'] : FALLBACK_AUTH_SOURCE,
    phase: isOneOf(PHASES, src['phase']) ? src['phase'] : FALLBACK_PHASE,
    providerHttp: asHttpStatus(src['providerHttp']),
    providerCategory: isOneOf(PROVIDER_CATEGORIES, src['providerCategory'])
      ? src['providerCategory']
      : FALLBACK_PROVIDER_CATEGORY,
  };
}

function unavailableWith(
  reason: UnavailableReason,
  authSource: AuthSource,
  phase: ProbePhase,
  providerHttp: number | null,
  providerCategory: ProviderCategory,
): PdfProbeUnavailable {
  return {
    kind: 'unavailable',
    reason,
    diagnostic: sanitizeProbeDiagnostic({ reason, authSource, phase, providerHttp, providerCategory }),
  };
}

/**
 * Runs the existing bounded verifier with phase tracking and sanitized
 * provider HTTP status and category capture. A `verified` result is returned
 * unchanged. An `unavailable` result carries a bounded `diagnostic`.
 *
 * Order of operations:
 *   1. Validate the file ID (phase `input`) before touching any dependency.
 *   2. `ensureAuth()` (phase `auth`). A thrown error or `ok: false` yields
 *      `provider_error`.
 *   3. Delegate to `verifyBoundedPdf` with wrapped deps. The verifier's caps
 *      and deadlines are untouched; wrappers only record the current phase, a
 *      safe HTTP status, and a bounded category, then rethrow so the verifier
 *      decides the outcome.
 */
export async function probePdfWithDiagnostics(
  fileId: string,
  deps: DrivePdfProbeDeps,
): Promise<PdfProbeResult> {
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) {
    return unavailableWith('invalid_file_id', 'unknown', 'input', null, 'unknown');
  }

  let authSource: AuthSource = 'unknown';
  try {
    const auth = await deps.ensureAuth();
    const source = auth !== null && typeof auth === 'object' ? auth.source : undefined;
    authSource = isOneOf(AUTH_SOURCES, source) ? source : 'unknown';
    if (auth === null || typeof auth !== 'object' || auth.ok !== true) {
      return unavailableWith('provider_error', authSource, 'auth', null, 'unknown');
    }
  } catch (err) {
    return unavailableWith(
      'provider_error',
      'unknown',
      'auth',
      extractProviderHttp(err),
      extractProviderCategory(err),
    );
  }

  const state: {
    phase: ProbePhase;
    metadataCalls: number;
    providerHttp: number | null;
    providerCategory: ProviderCategory;
  } = {
    phase: 'metadata-before',
    metadataCalls: 0,
    providerHttp: null,
    providerCategory: 'unknown',
  };

  const capture = (err: unknown): void => {
    if (state.providerHttp === null) {
      state.providerHttp = extractProviderHttp(err);
    }
    if (state.providerCategory === 'unknown') {
      state.providerCategory = extractProviderCategory(err);
    }
  };

  const wrapped = {
    async metadata(): Promise<DriveFileMetadata> {
      state.phase = state.metadataCalls === 0 ? 'metadata-before' : 'metadata-after';
      state.metadataCalls += 1;
      try {
        return await deps.metadata();
      } catch (err) {
        capture(err);
        throw err;
      }
    },
    chunks(): AsyncIterable<Uint8Array> {
      return (async function* tracked(): AsyncGenerator<Uint8Array, void, undefined> {
        state.phase = 'media';
        try {
          for await (const chunk of deps.chunks()) {
            yield chunk;
          }
        } catch (err) {
          capture(err);
          throw err;
        }
      })();
    },
  };

  const result: PdfByteResult = await verifyBoundedPdf(fileId, wrapped);

  if (result.kind === 'verified') {
    return result;
  }

  const phase: ProbePhase = result.reason === 'invalid_file_id' ? 'input' : state.phase;
  return unavailableWith(result.reason, authSource, phase, state.providerHttp, state.providerCategory);
}
