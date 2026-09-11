// Fictional public fixtures; historical provider packet is private.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLegacyRecoveryProof,
  stableRecoveryDigest,
} from '../src/lib/legacy-affidavit-recovery-proof';

const TARGET_ID = '9c1e4d2a-7b3f-4e8c-a1d5-2f6b8c9d0e1a';
const ACCOUNT = 'WTB-0723';
const POSTED_DATE = '2026-08-12T00:00:00.000Z';
const RAW_DESCRIPTOR =
  'MISCELLANEOUS DEBIT EXAMPLE STORE #00001* 555-010-0101  NC C#4321 DBT CRD 1025 08/11/26 11223344';
const OWNER_USER = 'users/111111111111111111111';
const BOT_USER = 'users/222222222222222222222';
const PDF_ID = 'fictional_pdf_1234567890';
const PDF_SHA256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEGACY_SIGNED_AT = '2026-08-27T06:50:35.204377';
const REQUEST_NAME = 'spaces/fictionalSpace/messages/requestExample.requestExample';
const REPLY_TEXT =
  '@Beverly #1 was lost after wrong phone number; assign Example project finish materials. no sales tax to calculate.';
const IMPORT_ID = 'statement_example';

type AnyRecord = Record<string, any>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makePacket(overrides: (p: AnyRecord) => void = () => {}): AnyRecord {
  const packet: AnyRecord = {
    contractVersion: 1,
    provenanceKind: 'admin-attested-provider-packet',
    approvingAdmin: {
      email: 'admin@example.test',
      instructionReference: 'approved-recovery-20260910',
    },
    target: {
      bankLineId: TARGET_ID,
      account: ACCOUNT,
      amountCents: -1234,
      postedDate: '2026-08-12',
      purchaseDate: '2026-08-11',
      cardLast4: '4321',
      bankReference: '11223344',
      legacyFingerprint: 'a54105515a1a',
    },
    pdf: { id: PDF_ID, sha256: PDF_SHA256 },
    owner: { label: 'Example Purchaser', chatUser: OWNER_USER },
    originalRequest: {
      name: REQUEST_NAME,
      thread: 'spaces/fictionalSpace/threads/requestExample',
      sender: BOT_USER,
      senderType: 'BOT',
      text: 'Example Purchaser card 4321: 1. Aug 11 Example Store #00001 $12.34; 2. Aug 13 Second Store $200.00',
      createTime: '2026-08-26T22:04:09.651679Z',
      item: 1,
    },
    originalHuman: {
      name: 'spaces/fictionalSpace/messages/replyExample.replyExample',
      thread: 'spaces/fictionalSpace/threads/replyExample',
      sender: OWNER_USER,
      senderType: 'HUMAN',
      text: REPLY_TEXT,
      createTime: '2026-08-27T13:49:43.671887Z',
      quotedMessageName: REQUEST_NAME,
      quoteType: 'REPLY',
    },
    legacy: {
      signedAtVerbatim: LEGACY_SIGNED_AT,
      signedBy: 'Example Purchaser Lord',
      job: 'Example project',
      items: 'Finish materials',
      fingerprint: 'a54105515a1a',
    },
  };
  overrides(packet);
  return packet;
}

function makeCanonical(overrides: (c: AnyRecord) => void = () => {}): AnyRecord {
  const canonical: AnyRecord = {
    id: TARGET_ID,
    account: ACCOUNT,
    sourceOfRecord: 'STATEMENT',
    state: 'POSTED',
    amountCents: -1234,
    postedDate: POSTED_DATE,
    rawDescriptor: RAW_DESCRIPTOR,
    qbTxnId: null,
    probuildExpenseId: null,
    observationsTruncated: false,
    observations: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        account: ACCOUNT,
        source: 'STATEMENT',
        sourceDocumentId: IMPORT_ID,
        sourceLineId: '6',
        postedDate: POSTED_DATE,
        amountCents: -1234,
        rawDescriptor: RAW_DESCRIPTOR,
        statementImport: {
          id: IMPORT_ID,
          account: ACCOUNT,
          status: 'FINALIZED',
          periodStart: POSTED_DATE,
          periodEnd: POSTED_DATE,
          contentHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    ],
  };
  overrides(canonical);
  return canonical;
}

function expectOk(packet: unknown, canonical: unknown) {
  const result = validateLegacyRecoveryProof(packet, canonical);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.proof;
}

function expectRejected(packet: unknown, canonical: unknown, reasonPattern?: RegExp) {
  const result = validateLegacyRecoveryProof(packet, canonical);
  assert.equal(result.ok, false, 'expected rejection but validator accepted');
  if (result.ok) throw new Error('unreachable');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason must be non-empty');
  if (reasonPattern) assert.match(result.reason, reasonPattern);
  return result.reason;
}

describe('validateLegacyRecoveryProof', () => {
  test('accepts the authentic packet against the canonical line and returns full proof', () => {
    const proof = expectOk(makePacket(), makeCanonical());
    assert.deepEqual(Object.keys(proof).sort(), [
      'bankLineId',
      'legacySignedAtVerbatim',
      'originalMessageAt',
      'originalReply',
      'packetDigest',
      'pdfId',
      'pdfSha256',
    ]);
    assert.equal(proof.bankLineId, TARGET_ID);
    assert.equal(proof.pdfId, PDF_ID);
    assert.equal(proof.pdfSha256, PDF_SHA256);
    assert.equal(proof.originalReply, REPLY_TEXT);
    assert.equal(proof.originalMessageAt, '2026-08-27T13:49:43.671887Z');
    assert.match(proof.packetDigest, /^[0-9a-f]{64}$/);
  });

  test('preserves legacy signedAt verbatim without timezone normalization', () => {
    const proof = expectOk(makePacket(), makeCanonical());
    assert.equal(proof.legacySignedAtVerbatim, LEGACY_SIGNED_AT);
    assert.ok(!proof.legacySignedAtVerbatim.endsWith('Z'));
    assert.ok(!/[+-]\d{2}:\d{2}$/.test(proof.legacySignedAtVerbatim));
  });

  test('accepts a reply posted in a different thread when the provider quote is exact', () => {
    const packet = makePacket((p) => {
      p.originalHuman.thread = 'spaces/fictionalSpace/threads/zzzDifferentThread';
      p.originalHuman.quotedMessageName = REQUEST_NAME;
    });
    const proof = expectOk(packet, makeCanonical());
    assert.equal(proof.originalReply, REPLY_TEXT);
  });

  test('rejects a reply quoting the wrong legacy provider message', () => {
    const packet = makePacket((p) => {
      p.originalHuman.quotedMessageName = 'spaces/fictionalSpace/messages/WRONGmsg.WRONGmsg';
    });
    expectRejected(packet, makeCanonical(), /quot/i);
  });

  test('rejects a reply from a sender other than the card owner', () => {
    const packet = makePacket((p) => {
      p.originalHuman.sender = 'users/000000000000000000000';
    });
    expectRejected(packet, makeCanonical(), /sender|owner/i);
  });

  test('rejects a card last4 that does not appear in the canonical descriptor', () => {
    const packet = makePacket((p) => {
      p.target.cardLast4 = '1234';
    });
    expectRejected(packet, makeCanonical(), /card/i);
  });

  test('rejects an amount mismatch between packet and canonical line', () => {
    const packet = makePacket((p) => {
      p.target.amountCents = -6141;
    });
    expectRejected(packet, makeCanonical(), /amount/i);
    const canonical = makeCanonical((c) => {
      c.amountCents = 1234;
    });
    expectRejected(makePacket(), canonical, /amount/i);
  });

  test('rejects a posted date mismatch', () => {
    const packet = makePacket((p) => {
      p.target.postedDate = '2026-08-13';
    });
    expectRejected(packet, makeCanonical(), /date/i);
    const canonical = makeCanonical((c) => {
      c.postedDate = '2026-08-13T00:00:00.000Z';
      c.observations[0].postedDate = '2026-08-13T00:00:00.000Z';
    });
    expectRejected(makePacket(), canonical, /date/i);
  });

  test('rejects a bank reference not present in the canonical descriptor', () => {
    const packet = makePacket((p) => {
      p.target.bankReference = '55247987';
    });
    expectRejected(packet, makeCanonical(), /reference/i);
  });

  test('rejects a canonical line whose source of record is not STATEMENT', () => {
    const canonical = makeCanonical((c) => {
      c.sourceOfRecord = 'MANUAL';
    });
    expectRejected(makePacket(), canonical, /source/i);
    const obsCanonical = makeCanonical((c) => {
      c.observations[0].source = 'MANUAL';
    });
    expectRejected(makePacket(), obsCanonical, /source/i);
  });

  test('rejects an account mismatch anywhere in the chain', () => {
    const packet = makePacket((p) => {
      p.target.account = 'WTB-0001';
    });
    expectRejected(packet, makeCanonical(), /account/i);
    const canonical = makeCanonical((c) => {
      c.observations[0].statementImport.account = 'WTB-0001';
    });
    expectRejected(makePacket(), canonical, /account/i);
  });

  test('rejects when canonical observations are truncated', () => {
    const canonical = makeCanonical((c) => {
      c.observationsTruncated = true;
    });
    expectRejected(makePacket(), canonical, /truncat/i);
  });

  test('rejects when multiple observations carry authoritative references', () => {
    const canonical = makeCanonical((c) => {
      const second = clone(c.observations[0]);
      second.id = '5f2a1b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
      second.sourceLineId = '7';
      c.observations.push(second);
    });
    expectRejected(makePacket(), canonical, /observation|multiple|ambig/i);
  });

  test('rejects when the statement import is not FINALIZED', () => {
    const canonical = makeCanonical((c) => {
      c.observations[0].statementImport.status = 'DRAFT';
    });
    expectRejected(makePacket(), canonical, /final/i);
  });

  test('rejects an observation with a missing source line id', () => {
    const canonical = makeCanonical((c) => {
      delete c.observations[0].sourceLineId;
    });
    expectRejected(makePacket(), canonical, /line/i);
    const emptyCanonical = makeCanonical((c) => {
      c.observations[0].sourceLineId = '';
    });
    expectRejected(makePacket(), emptyCanonical, /line/i);
  });

  test('rejects a canonical line that is already linked to an expense or QB transaction', () => {
    const linkedProbuild = makeCanonical((c) => {
      c.probuildExpenseId = 'exp_123';
    });
    expectRejected(makePacket(), linkedProbuild, /link|expense/i);
    const linkedQb = makeCanonical((c) => {
      c.qbTxnId = '4471';
    });
    expectRejected(makePacket(), linkedQb, /link|qb/i);
  });

  test('rejects when target bankLineId does not match canonical id', () => {
    const canonical = makeCanonical((c) => {
      c.id = '00000000-0000-4000-8000-000000000000';
    });
    expectRejected(makePacket(), canonical, /id/i);
  });

  test('rejects wrong contract version or provenance kind', () => {
    expectRejected(
      makePacket((p) => {
        p.contractVersion = 2;
      }),
      makeCanonical(),
      /version/i,
    );
    expectRejected(
      makePacket((p) => {
        p.provenanceKind = 'self-attested';
      }),
      makeCanonical(),
      /provenance/i,
    );
  });

  test('rejects a legacy fingerprint that disagrees with the target fingerprint', () => {
    const packet = makePacket((p) => {
      p.legacy.fingerprint = 'deadbeef0000';
    });
    expectRejected(packet, makeCanonical(), /fingerprint/i);
  });

  test('rejects a human reply whose senderType is not HUMAN or quoteType is not REPLY', () => {
    expectRejected(
      makePacket((p) => {
        p.originalHuman.senderType = 'BOT';
      }),
      makeCanonical(),
    );
    expectRejected(
      makePacket((p) => {
        p.originalHuman.quoteType = 'FORWARD';
      }),
      makeCanonical(),
    );
  });

  test('fails closed on malformed or non-object inputs', () => {
    const malformed: unknown[] = [null, undefined, 'packet', 42, [], true];
    for (const bad of malformed) {
      expectRejected(bad, makeCanonical());
      expectRejected(makePacket(), bad);
    }
    expectRejected({}, makeCanonical());
    expectRejected(makePacket(), {});
    expectRejected(
      makePacket((p) => {
        delete p.originalHuman;
      }),
      makeCanonical(),
    );
    expectRejected(
      makePacket((p) => {
        delete p.pdf;
      }),
      makeCanonical(),
    );
  });

  test('rejects non-finite or unsafe integer amounts', () => {
    const badAmounts = [Number.NaN, Number.POSITIVE_INFINITY, -1234.5, '-1234', 2 ** 53, -(2 ** 53)];
    for (const amount of badAmounts) {
      expectRejected(
        makePacket((p) => {
          p.target.amountCents = amount;
        }),
        makeCanonical(),
      );
      expectRejected(
        makePacket(),
        makeCanonical((c) => {
          c.amountCents = amount;
          c.observations[0].amountCents = amount;
        }),
      );
    }
  });

  test('rejects malformed pdf sha256 or missing pdf id', () => {
    expectRejected(
      makePacket((p) => {
        p.pdf.sha256 = 'not-a-hash';
      }),
      makeCanonical(),
      /sha|pdf/i,
    );
    expectRejected(
      makePacket((p) => {
        p.pdf.id = '';
      }),
      makeCanonical(),
      /pdf/i,
    );
  });

  test('does not mutate its inputs', () => {
    const packet = makePacket();
    const canonical = makeCanonical();
    const packetSnapshot = clone(packet);
    const canonicalSnapshot = clone(canonical);
    validateLegacyRecoveryProof(packet, canonical);
    assert.deepEqual(packet, packetSnapshot);
    assert.deepEqual(canonical, canonicalSnapshot);
  });

  test('packetDigest is deterministic across identical inputs', () => {
    const a = expectOk(makePacket(), makeCanonical());
    const b = expectOk(makePacket(), makeCanonical());
    assert.equal(a.packetDigest, b.packetDigest);
  });

  test('packetDigest changes when reply whitespace changes', () => {
    const base = expectOk(makePacket(), makeCanonical());
    const spaced = expectOk(
      makePacket((p) => {
        p.originalHuman.text = REPLY_TEXT + ' ';
      }),
      makeCanonical(),
    );
    assert.notEqual(base.packetDigest, spaced.packetDigest);
    assert.equal(spaced.originalReply, REPLY_TEXT + ' ');
  });
});

describe('stableRecoveryDigest', () => {
  test('returns a lowercase hex sha256-length string', () => {
    const digest = stableRecoveryDigest({ a: 1 });
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test('is invariant to object key ordering, including nested objects', () => {
    const one = stableRecoveryDigest({ a: 1, b: { x: 'y', z: [1, 2] }, c: 'q' });
    const two = stableRecoveryDigest({ c: 'q', b: { z: [1, 2], x: 'y' }, a: 1 });
    assert.equal(one, two);
  });

  test('is sensitive to array ordering and whitespace in strings', () => {
    assert.notEqual(stableRecoveryDigest({ a: [1, 2] }), stableRecoveryDigest({ a: [2, 1] }));
    assert.notEqual(stableRecoveryDigest({ t: 'a b' }), stableRecoveryDigest({ t: 'a  b' }));
    assert.notEqual(stableRecoveryDigest({ t: 'a' }), stableRecoveryDigest({ t: 'a ' }));
  });

  test('distinguishes types and null from undefined-free equivalents', () => {
    assert.notEqual(stableRecoveryDigest({ n: 1 }), stableRecoveryDigest({ n: '1' }));
    assert.notEqual(stableRecoveryDigest({ n: null }), stableRecoveryDigest({}));
    assert.equal(stableRecoveryDigest('x'), stableRecoveryDigest('x'));
  });
});