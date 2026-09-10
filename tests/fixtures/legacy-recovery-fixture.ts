import type { Packet } from '../../src/lib/legacy-affidavit-recovery-proof';
// Fictional test data only.
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

export function makePacket(overrides: (p: AnyRecord) => void = () => {}): AnyRecord {
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

export function makeCanonical(overrides: (c: AnyRecord) => void = () => {}): AnyRecord {
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

export function fixture() { return { packet: makePacket() as Packet, canonical: makeCanonical() }; }
