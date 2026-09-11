import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  probePdfWithDiagnostics,
  sanitizeProbeDiagnostic,
  extractProviderHttp,
  extractProviderCategory,
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
    diagnostic: { reason: 'invalid_file_id', authSource: 'unknown', phase: 'input', providerHttp: null, providerCategory: 'unknown' },
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
    diagnostic: { reason: 'provider_error', authSource: 'none', phase: 'auth', providerHttp: null, providerCategory: 'unknown' },
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
    diagnostic: { reason: 'provider_error', authSource: 'unknown', phase: 'auth', providerHttp: 401, providerCategory: 'unknown' },
  });
  assert.equal(rec.metadataCalls, 0);
  assert.equal(JSON.stringify(result).includes('secret-refresh-token-value'), false);
});

test('auth throwing with OAuth invalid_client body yields the invalid_client category', async () => {
  const err = Object.assign(new Error('refresh failed: secret-refresh-token-value'), {
    response: { status: 401, data: { error: 'invalid_client', error_description: 'secret-refresh-token-value' } },
  });
  const { deps, rec } = makeDeps({ auth: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'unknown', phase: 'auth', providerHttp: 401, providerCategory: 'invalid_client' },
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
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: 404, providerCategory: 'unknown' },
  });
});

test('metadata failing with 400 invalid_grant OAuth body yields the invalid_grant category', async () => {
  const err = Object.assign(new Error('invalid_grant: secret-refresh-token-value'), {
    response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
  });
  const { deps, rec } = makeDeps({ metadata: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: 400, providerCategory: 'invalid_grant' },
  });
  assert.equal(rec.chunksCalls, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secret-refresh-token-value'), false);
  assert.equal(serialized.includes('expired'), false);
});

test('metadata failing with 400 alone (no structured reason) stays providerCategory unknown', async () => {
  const err = Object.assign(new Error('Bad Request'), { response: { status: 400, data: {} } });
  const { deps } = makeDeps({ metadata: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: 400, providerCategory: 'unknown' },
  });
});

test('Drive insufficientPermissions in response.data.error.errors is categorised in media phase', async () => {
  const err = Object.assign(new Error('The user does not have sufficient permissions for this file.'), {
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          message: 'The user does not have sufficient permissions for this file.',
          errors: [{ domain: 'global', reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
        },
      },
    },
  });
  const { deps } = makeDeps({ chunks: () => throwingStream(err, PDF_BYTES.subarray(0, 5)) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'media', providerHttp: 403, providerCategory: 'insufficientPermissions' },
  });
  assert.equal(JSON.stringify(result).includes('sufficient permissions'), false);
});

test('flattened err.errors[i].reason (Google API details) is categorised', async () => {
  const err = Object.assign(new Error('File not found: secret-path'), {
    code: 404,
    errors: [{ domain: 'global', reason: 'notFound', message: 'File not found: secret-path', locationType: 'parameter', location: 'fileId' }],
  });
  const { deps } = makeDeps({ metadata: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: 404, providerCategory: 'notFound' },
  });
  assert.equal(JSON.stringify(result).includes('secret-path'), false);
});

test('media stream failing with code 403 is attributed to media phase', async () => {
  const err = Object.assign(new Error('forbidden'), { code: 403 });
  const { deps } = makeDeps({ chunks: () => throwingStream(err, PDF_BYTES.subarray(0, 5)) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'media', providerHttp: 403, providerCategory: 'unknown' },
  });
});

test('invalid metadata (wrong mime) yields metadata_rejected in metadata-before with null status', async () => {
  const { deps, rec } = makeDeps({ metadata: async () => goodMetadata({ mimeType: 'image/png' }) });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'metadata_rejected',
    diagnostic: { reason: 'metadata_rejected', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: null, providerCategory: 'unknown' },
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
    diagnostic: { reason: 'metadata_changed', authSource: 'company-settings', phase: 'metadata-after', providerHttp: null, providerCategory: 'unknown' },
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
    diagnostic: { reason: 'content_rejected', authSource: 'token-file-or-env', phase: 'media', providerHttp: null, providerCategory: 'unknown' },
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
    assert.deepEqual(Object.keys(result.diagnostic).sort(), ['authSource', 'phase', 'providerCategory', 'providerHttp', 'reason']);
    assert.equal(result.diagnostic.providerHttp, null);
    assert.equal(result.diagnostic.providerCategory, 'unknown');
    assert.equal(result.diagnostic.phase, 'media');
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('example.invalid'), false);
  assert.equal(serialized.includes('ECONNRESET'), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('unknown structured reasons and secret-bearing payloads never echo through providerCategory', async () => {
  const secret = 'secret-reason-payload-DO-NOT-LEAK';
  const err = Object.assign(new Error(secret), {
    response: {
      status: 403,
      data: {
        error: {
          errors: [{ reason: secret, message: secret }, { reason: 'customQuotaThing' }],
          message: secret,
        },
      },
    },
    errors: [{ reason: `${secret}-flat` }],
  });
  const { deps } = makeDeps({ metadata: async () => { throw err; } });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'token-file-or-env', phase: 'metadata-before', providerHttp: 403, providerCategory: 'unknown' },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('customQuotaThing'), false);
});

test('extractProviderCategory is exact, bounded to 10 entries, and collapses conflicts to unknown', () => {
  assert.equal(extractProviderCategory({ response: { data: { error: 'invalid_grant' } } }), 'invalid_grant');
  assert.equal(extractProviderCategory({ response: { data: { error: 'access_denied' } } }), 'access_denied');
  assert.equal(extractProviderCategory({ response: { data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } }), 'rateLimitExceeded');
  assert.equal(extractProviderCategory({ errors: [{ reason: 'backendError' }] }), 'backendError');

  // same known category repeated is not a conflict
  assert.equal(
    extractProviderCategory({ response: { data: { error: { errors: [{ reason: 'forbidden' }] } } }, errors: [{ reason: 'forbidden' }] }),
    'forbidden',
  );

  // distinct known categories conflict -> unknown, no guessed priority
  assert.equal(extractProviderCategory({ errors: [{ reason: 'notFound' }, { reason: 'forbidden' }] }), 'unknown');
  assert.equal(
    extractProviderCategory({ response: { data: { error: 'invalid_grant' } }, errors: [{ reason: 'badRequest' }] }),
    'unknown',
  );

  // Oversized arrays are rejected; up to 10 entries are inspected.
  const padded = Array.from({ length: 10 }, () => ({ reason: 'ignored-filler' }));
  assert.equal(extractProviderCategory({ errors: [...padded, { reason: 'notFound' }] }), 'unknown');
  assert.equal(extractProviderCategory({ errors: [...padded.slice(0, 9), { reason: 'notFound' }] }), 'notFound');

  // exact match only: case, whitespace, substrings, and messages are not consulted
  assert.equal(extractProviderCategory({ response: { data: { error: 'Invalid_Grant' } } }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error: ' invalid_grant' } } }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error: 'invalid_grant: expired' } } }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error: '{"error":"invalid_grant"}' } } }), 'unknown');
  assert.equal(extractProviderCategory(new Error('invalid_grant')), 'unknown');
  assert.equal(extractProviderCategory({ message: 'invalid_grant', error_description: 'invalid_grant' }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error_description: 'invalid_grant' } } }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error: { message: 'notFound' } } } }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error: { errors: 'notFound' } } } }), 'unknown');
  assert.equal(extractProviderCategory({ errors: ['notFound'] }), 'unknown');
  assert.equal(extractProviderCategory({ errors: [{ reason: 'unknown' }] }), 'unknown');
  assert.equal(extractProviderCategory({ response: { status: 400 } }), 'unknown');
  assert.equal(extractProviderCategory(null), 'unknown');
  assert.equal(extractProviderCategory('invalid_grant'), 'unknown');
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
      providerCategory: 'backendError',
      extra: 'dropped',
      message: 'raw message dropped',
    }),
    { reason: 'timeout', authSource: 'company-settings', phase: 'media', providerHttp: 504, providerCategory: 'backendError' },
  );

  assert.deepEqual(
    sanitizeProbeDiagnostic({
      reason: 'something_else',
      authSource: 'ldap',
      phase: 'download',
      providerHttp: '500',
      providerCategory: 'raw-provider-reason-must-not-echo',
    }),
    { reason: 'provider_error', authSource: 'unknown', phase: 'input', providerHttp: null, providerCategory: 'unknown' },
  );

  assert.deepEqual(sanitizeProbeDiagnostic(null), {
    reason: 'provider_error',
    authSource: 'unknown',
    phase: 'input',
    providerHttp: null,
    providerCategory: 'unknown',
  });
  assert.deepEqual(sanitizeProbeDiagnostic('garbage'), {
    reason: 'provider_error',
    authSource: 'unknown',
    phase: 'input',
    providerHttp: null,
    providerCategory: 'unknown',
  });
  assert.deepEqual(sanitizeProbeDiagnostic({ providerHttp: 1000 }).providerHttp, null);
  assert.deepEqual(sanitizeProbeDiagnostic({ providerHttp: 200 }).providerHttp, 200);
  assert.equal(sanitizeProbeDiagnostic({ providerCategory: 'invalid_grant' }).providerCategory, 'invalid_grant');
  assert.equal(sanitizeProbeDiagnostic({ providerCategory: 'Invalid_Grant' }).providerCategory, 'unknown');
  assert.equal(sanitizeProbeDiagnostic({ providerCategory: 42 }).providerCategory, 'unknown');
  assert.equal(sanitizeProbeDiagnostic({}).providerCategory, 'unknown');
});

test('malformed auth result (non-object) is treated as unavailable auth', async () => {
  const { deps, rec } = makeDeps({ auth: (async () => undefined) as unknown as () => Promise<AuthStatus> });
  const result = await probePdfWithDiagnostics(FILE_ID, deps);

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'provider_error',
    diagnostic: { reason: 'provider_error', authSource: 'unknown', phase: 'auth', providerHttp: null, providerCategory: 'unknown' },
  });
  assert.equal(rec.metadataCalls, 0);
});


test('oversized reason arrays cannot hide a conflicting category after the bound', () => {
  const errors = [...Array.from({ length: 10 }, () => ({ reason: 'invalid_grant' })), { reason: 'badRequest' }];
  assert.equal(extractProviderCategory({ errors }), 'unknown');
  assert.equal(extractProviderCategory({ response: { data: { error: { errors } } } }), 'unknown');
});
