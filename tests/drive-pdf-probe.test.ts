import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  probePdfWithDiagnostics,
  sanitizeProbeDiagnostic,
  extractProviderHttp,
  type DrivePdfProbeDeps,
  type AuthStatus,
} from '../src/lib/drive-pdf-probe';
import { verifyBoundedPdf, type DriveFileMetadata } from '../src/lib/drive-pdf-bytes';

// Synthetic, non-real identifier that satisfies the verifier's pattern.
const FILE_ID = 'synthetic-test-file-id-0001';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');

function goodMetadata(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id: FILE_ID,
    mimeType: 'application/pdf',
    trashed: false,
    version: '7',
    size: String(PDF_BYTES.byteLength),
    ...overrides,
  };
}

async function* streamOf(bytes: Uint8Array, chunkSize = 7): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
  }
}

async function* throwingStream(err: unknown, before: Uint8Array | null = null): AsyncGenerator<Uint8Array> {
  if (before !== null) yield before;
  throw err;
}

const okAuth: AuthStatus = { ok: true, source: 'token-file-or-env' };

interface Recorder {
  authCalls: number;
  metadataCalls: number;
  chunksCalls: number;
}

function makeDeps(opts: {
  auth?: () => Promise<AuthStatus>;
  metadata?: () => Promise<DriveFileMetadata>;
  chunks?: () => AsyncIterable<Uint8Array>;
}): { deps: DrivePdfProbeDeps; rec: Recorder } {
  const rec: Recorder = { authCalls: 0, metadataCalls: 0, chunksCalls: 0 };
  const deps: DrivePdfProbeDeps = {
    async ensureAuth() {
      rec.authCalls += 1;
      return (opts.auth ?? (async () => okAuth))();
    },
    async metadata() {
      rec.metadataCalls += 1;
      return (opts.metadata ?? (async () => goodMetadata()))();
    },
    chunks() {
      rec.chunksCalls += 1;
      return (opts.chunks ?? (() => streamOf(PDF_BYTES)))();
    },
  };
  return { deps, rec };
}

test('valid PDF returns the verified result unchanged from the real verifier', async () => {
  const { deps, rec } = makeDeps({});
  const result = await probePdfWithDiagnostics(FILE_ID, deps);
  const direct = await verifyBoundedPdf(FILE_ID, makeDeps({}).deps);

  assert.equal(result.kind, 'verified');
  assert.deepEqual(result, direct);
  if (result.kind === 'verified') {
    assert.equal(result.sha256, createHash('sha256').update(PDF_BYTES).digest('hex'));
    assert.equal(result.byteLength, PDF_BYTES.byteLength);
    assert.equal(result.version, '7');
    assert.equal('diagnostic' in result, false);
  }
  assert.equal(rec.authCalls, 1);
  assert.equal(rec.metadataCalls, 2);
  assert.equal(rec.chunksCalls, 1);
});

test('invalid file ID is rejected before any dependency is invoked', async () => {
  const { deps, rec } = makeDeps({});
  const result = await probePdfWithDiagnostics('bad id!', deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'invalid_file_id',
    diagnostic: { reason: 'invalid_file_id', authSource: 'unknown', phase: 'input', providerHttp: null },
  });
  assert.equal(rec.authCalls, 0);
  assert.equal(rec.metadataCalls, 0);
  assert.equal(rec.chunksCalls, 0);
});

test('auth absent (ok:false, source none) yields provider_error in auth phase without touching Drive', async () => {
  const { deps, rec } = makeDeps({ auth: async () => ({ ok: false, source: 'none' }) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'none', phase: 'auth', providerHttp: null },
  });
  assert.equal(rec.metadataCalls, 0);
  assert.equal(rec.chunksCalls, 0);
});

test('auth throwing with status 401 is captured as sanitized HTTP status', async () => {
  const err = Object.assign(new Error('token refresh failed: secret-refresh-token-value'), { status: 401 });
  const { deps, rec } = makeDeps({ auth: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'unknown', phase: 'auth', providerHttp: 401 },
  });
  assert.equal(rec.metadataCalls, 0);
  assert.equal(JSON.stringify(result).includes('secret-refresh-token-value'), false);
});

test('metadata failing with response.status 404 is attributed to metadata-before', async () => {
  const err = Object.assign(new Error('File not found'), { response: { status: 404 } });
  const { deps } = makeDeps({ metadata: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: 404 },
  });
});

test('media stream failing with code 403 is attributed to media phase', async () => {
  const err = Object.assign(new Error('forbidden'), { code: 403 });
  const { deps } = makeDeps({ chunks: () => throwingStream(err, PDF_BYTES.subarray(0, 5)) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'media', providerHttp: 403 },
  });
});

test('invalid metadata (wrong mime) yields metadata_rejected in metadata-before with null status', async () => {
  const { deps, rec } = makeDeps({ metadata: async () => goodMetadata({ mimeType: 'image/png' }) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'metadata_rejected',
    diagnostic: { reason: 'metadata_rejected', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: null },
  });
  assert.equal(rec.chunksCalls, 0);
});

test('metadata changing between calls yields metadata_changed in metadata-after', async () => {
  let calls = 0;
  const { deps } = makeDeps({
    auth: async () => ({ ok: true, source: 'company-settings' }),
    metadata: async () => {
      calls += 1;
      return calls === 1 ? goodMetadata({ version: '7' }) : goodMetadata({ version: '8' });
    },
  });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'metadata_changed',
    diagnostic: { reason: 'metadata_changed', authSource: 'company-settings', phase: 'metadata-after', providerHttp: null },
  });
  assert.equal(calls, 2);
});

test('bad content (missing %PDF- magic) yields content_rejected in media phase', async () => {
  const bad = new TextEncoder().encode('<html>not a pdf</html>');
  const { deps } = makeDeps({
    metadata: async () => goodMetadata({ size: String(bad.byteLength) }),
    chunks: () => streamOf(bad),
  });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'content_rejected',
    diagnostic: { reason: 'content_rejected', authSource: 'token-file-or-env', phase: 'media', providerHttp: null },
  });
});

test('arbitrary raw error with secrets is never serialized into the result', async () => {
  const secret = 'ya29.SUPER-SECRET-ACCESS-TOKEN-DO-NOT-LEAK';
  const rawError = {
    message: `Request to https://example.invalid/drive?access_token=${secret} failed`,
    config: { headers: { Authorization: `Bearer ${secret}` } },
    response: { status: 'not-a-number', data: { error: secret } },
    code: 'ECONNRESET',
    stack: `Error: ${secret}`,
  };
  const { deps } = makeDeps({ chunks: () => throwingStream(rawError) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.equal(result.kind, 'unavailable');
  if (result.kind === 'unavailable') {
    assert.equal(result.reason, 'provider_error');
    assert.deepEqual(Object.keys(result).sort(), ['diagnostic', 'kind', 'reason']);
    assert.deepEqual(Object.keys(result.diagnostic).sort(), ['authSource', 'phase', 'providerHttp', 'reason']);
    assert.equal(result.diagnostic.providerHttp, null);
    assert.equal(result.diagnostic.phase, 'media');
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('example.invalid'), false);
  assert.equal(serialized.includes('ECONNRESET'), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('extractProviderHttp only accepts integer statuses in 100..599', () => {
  assert.equal(extractProviderHttp({ response: { status: 503 } }), 503);
  assert.equal(extractProviderHttp({ status: 429 }), 429);
  assert.equal(extractProviderHttp({ code: 500 }), 500);
  assert.equal(extractProviderHttp({ status: 99 }), null);
  assert.equal(extractProviderHttp({ status: 600 }), null);
  assert.equal(extractProviderHttp({ status: 404.5 }), null);
  assert.equal(extractProviderHttp({ status: '404' }), null);
  assert.equal(extractProviderHttp({ code: 'ENOTFOUND' }), null);
  assert.equal(extractProviderHttp(new Error('plain')), null);
  assert.equal(extractProviderHttp(null), null);
  assert.equal(extractProviderHttp('string error'), null);
  assert.equal(extractProviderHttp({ response: { status: 502 }, status: 404 }), 502);
});

test('sanitizeProbeDiagnostic bounds unknown objects to the exact whitelist', () => {
  assert.deepEqual(
    sanitizeProbeDiagnostic({
      reason: 'timeout',
      authSource: 'company-settings',
      phase: 'media',
      providerHttp: 504,
      extra: 'dropped',
      message: 'raw message dropped',
    }),
    { reason: 'timeout', authSource: 'company-settings', phase: 'media', providerHttp: 504 },
  );

  assert.deepEqual(
    sanitizeProbeDiagnostic({
      reason: 'something_else',
      authSource: 'ldap',
      phase: 'download',
      providerHttp: '500',
    }),
    { reason: 'provider_error', authSource: 'unknown', phase: 'input', providerHttp: null },
  );

  assert.deepEqual(sanitizeProbeDiagnostic(null), {
    reason: 'provider_error',
    authSource: 'unknown',
    phase: 'input',
    providerHttp: null,
  });
  assert.deepEqual(sanitizeProbeDiagnostic('garbage'), {
    reason: 'provider_error',
    authSource: 'unknown',
    phase: 'input',
    providerHttp: null,
  });
  assert.deepEqual(sanitizeProbeDiagnostic({ providerHttp: 1000 }).providerHttp, null);
  assert.deepEqual(sanitizeProbeDiagnostic({ providerHttp: 200 }).providerHttp, 200);
});

test('malformed auth result (non-object) is treated as unavailable auth', async () => {
  const { deps, rec } = makeDeps({ auth: (async () => undefined) as unknown as () => Promise<AuthStatus> });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'unknown', phase: 'auth', providerHttp: null },
  });
  assert.equal(rec.metadataCalls, 0);
});
