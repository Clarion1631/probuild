import { stableRecoveryDigest, type Packet } from './legacy-affidavit-recovery-proof';
import type { RecoveryRequest, RecoveryResult } from './legacy-affidavit-recovery-service';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readBoundedBody } from './bank-source-refresh';

export const MAX_PACKET_BYTES = 65536;
export const MAX_BODY_BYTES = 2048;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PinnedRecoveryPacket {
  packet: Packet;
  packetDigest: string;
}

export interface LegacyRecoveryHandlerDeps {
  authorized(request: Request): boolean;
  enabled(): boolean;
  handle(req: RecoveryRequest): Promise<RecoveryResult>;
}

export type LegacyRecoveryHandler = (request: Request) => Promise<Response>;

const CONFIG_ERROR = 'legacy affidavit recovery packet configuration is missing or invalid';

function configError(): Error {
  return new Error(CONFIG_ERROR);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function decodeCanonicalBase64(encoded: string): Buffer {
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !BASE64_RE.test(encoded)) {
    throw configError();
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encoded) {
    throw configError();
  }
  return decoded;
}

function decodeUtf8Exact(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw configError();
  }
  return text;
}

function isPacketShape(value: unknown): value is Packet {
  if (!isPlainObject(value)) {
    return false;
  }
  const target = value.target;
  if (!isPlainObject(target)) {
    return false;
  }
  return typeof target.bankLineId === 'string' && target.bankLineId.length > 0;
}

export function loadPinnedRecoveryPacket(
  env: Record<string, string | undefined>,
): PinnedRecoveryPacket {
  const encoded = env.LEGACY_AFFIDAVIT_RECOVERY_PACKET_BASE64;
  const pinnedDigest = env.LEGACY_AFFIDAVIT_RECOVERY_PACKET_SHA256;

  if (typeof encoded !== 'string' || typeof pinnedDigest !== 'string') {
    throw configError();
  }
  if (!SHA256_HEX_RE.test(pinnedDigest)) {
    throw configError();
  }

  const rawBytes = decodeCanonicalBase64(encoded);
  if (rawBytes.length > MAX_PACKET_BYTES) {
    throw configError();
  }

  const actualDigest = createHash('sha256').update(rawBytes).digest('hex');
  if (!constantTimeHexEqual(actualDigest, pinnedDigest)) {
    throw configError();
  }

  const rawText = decodeUtf8Exact(rawBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw configError();
  }

  if (!isPacketShape(parsed)) {
    throw configError();
  }

  let packetDigest: string;
  try {
    packetDigest = stableRecoveryDigest(parsed);
  } catch {
    throw configError();
  }

  return { packet: parsed, packetDigest };
}

const ALLOWED_BODY_KEYS = new Set(['mode', 'bankLineId', 'planDigest']);

function parseRecoveryRequest(body: unknown): RecoveryRequest | null {
  if (!isPlainObject(body)) {
    return null;
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) {
      return null;
    }
  }
  const mode = body.mode;
  if (mode !== 'prepare' && mode !== 'apply') {
    return null;
  }
  const bankLineId = body.bankLineId;
  if (typeof bankLineId !== 'string' || !UUID_RE.test(bankLineId)) {
    return null;
  }
  const hasDigest = Object.prototype.hasOwnProperty.call(body, 'planDigest');
  const planDigest = body.planDigest;
  if (mode === 'apply') {
    if (typeof planDigest !== 'string' || !SHA256_HEX_RE.test(planDigest)) {
      return null;
    }
    return { mode, bankLineId, planDigest };
  }
  if (hasDigest) {
    if (typeof planDigest !== 'string' || !SHA256_HEX_RE.test(planDigest)) {
      return null;
    }
    return { mode, bankLineId, planDigest };
  }
  return { mode, bankLineId };
}

function respond(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

function statusCodeFor(result: RecoveryResult): number | null {
  switch (result.status) {
    case 'ready':
    case 'recovered':
    case 'already-recovered':
      return 200;
    case 'incomplete':
      return 503;
    case 'conflict':
      return 409;
    case 'rejected':
      return 422;
    default:
      return null;
  }
}

function isRecoveryResult(value: unknown): value is RecoveryResult {
  return (
    isPlainObject(value) &&
    typeof value.ok === 'boolean' &&
    typeof value.status === 'string'
  );
}

export function createLegacyRecoveryHandler(
  deps: LegacyRecoveryHandlerDeps,
): LegacyRecoveryHandler {
  return async function legacyRecoveryHandler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return respond(405, { error: 'method_not_allowed' });
    }

    let authorized = false;
    try {
      authorized = deps.authorized(request) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return respond(401, { error: 'unauthorized' });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return respond(400, { error: 'bad_request' });
    }
    if (url.search.length > 0) {
      return respond(400, { error: 'bad_request' });
    }

    let body: unknown;
    try {
      const raw = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!raw.ok) return respond(raw.reason === 'body-too-large' ? 413 : 400, {error:raw.reason});
      body = JSON.parse(raw.text);
    } catch {
      return respond(400, { error: 'bad_request' });
    }

    const recoveryRequest = parseRecoveryRequest(body);
    if (recoveryRequest === null) {
      return respond(400, { error: 'bad_request' });
    }

    if (recoveryRequest.mode === 'apply') {
      let enabled = false;
      try {
        enabled = deps.enabled() === true;
      } catch {
        enabled = false;
      }
      if (!enabled) {
        return respond(409, { error: 'disabled' });
      }
    }

    let result: RecoveryResult;
    try {
      const outcome: unknown = await deps.handle(recoveryRequest);
      if (!isRecoveryResult(outcome)) {
        return respond(503, { error: 'unavailable' });
      }
      result = outcome;
    } catch {
      return respond(503, { error: 'unavailable' });
    }

    const code = statusCodeFor(result);
    if (code === null) {
      return respond(503, { error: 'unavailable' });
    }

    return respond(code, { ...result, mode: recoveryRequest.mode });
  };
}