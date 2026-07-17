# PR 209 Production Security Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent uncommitted change-order approval attempts from retaining signature objects and make `/api/health` the exact, non-sensitive public production deployment probe.

**Architecture:** Add an owned signature-persistence handle whose `discard()` operation removes only the object created by that invocation. A focused approval coordinator transfers ownership only after `approveChangeOrderCore` commits and compensating-deletes on errors or a missing-row result. Keep the transaction core unchanged, and expose only the exact `/api/health` path through the production proxy.

**Tech Stack:** Next.js 16 App Router and Proxy, TypeScript, Prisma/PostgreSQL transactions, Supabase Storage, Playwright, PowerShell, Git.

## Global Constraints

- Work only in `C:\tmp\probuild-pr209-security-followup` on `codex/pr-209-security-followup`.
- Do not modify the canonical checkout at `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site`.
- Do not deploy, promote, revoke credentials, or delete local/remote branches.
- Preserve `approveChangeOrderCore` row locking and its Sent-state, item, positive-subtotal, subtotal-equality, and exactly-once invariants.
- Never log signature data, customer-entered signature names, storage paths, public signature URLs, bearer credentials, or raw cleanup errors.
- Keep `/api/health` free of authentication, database, storage, and third-party calls.
- Use test-first red/green cycles and commit after each independently reviewable task.
- No schema, migration, RLS, dependency, or package-lock changes are in scope.
- Keep direct Prisma access confined to the existing throwaway `e2e/money-pipeline.spec.ts` integration harness so the real PostgreSQL row-lock behavior remains testable; add no new production database access.
- Use `[PR-209]` for this PR follow-up and `[PB-health-001]` for the existing health specification because no separate Linear ticket was supplied.

## File responsibility map

- `src/lib/signature-storage.ts`: validate signature inputs, create unique Supabase objects, and return attempt-local ownership handles.
- `src/lib/change-order-approval.ts`: coordinate storage ownership with the existing approval transaction and sanitize cleanup-failure telemetry.
- `src/lib/change-order-core.ts`: unchanged source of transactional approval invariants.
- `src/lib/actions.ts`: authenticated server-action entry point; delegate cross-resource lifecycle to the coordinator.
- `e2e/money-pipeline.spec.ts`: low-level ownership tests plus real-database rejected/replay/concurrency cleanup assertions.
- `src/proxy.ts`: exact public path exclusion without widening adjacent API paths.
- `src/app/api/health/route.ts`: non-sensitive uncached deployment-probe response.
- `e2e/auth-status.spec.ts`: anonymous production-proxy contract coverage.
- `.specs/PB-health-001-health-endpoint.md`: supported production probe documentation.

---

### Task 1: Add an owned signature-storage handle

**Files:**
- Modify: `src/lib/signature-storage.ts:1-130`
- Test: `e2e/money-pipeline.spec.ts:1-10` and a new storage-focused describe block before the database suites

**Interfaces:**
- Consumes: existing `getSupabase()`, `STORAGE_BUCKET`, signature validation, upload deadline, and `upsert: false` behavior. Because the installed Supabase upload API exposes no proven cancellation signal, a deadline winner must still observe upload settlement and remove any late success before returning an error.
- Produces: `SignatureStorageBucket`, `SignaturePersistenceDependencies`, `OwnedSignature`, and `persistOwnedSignature(value, keyPrefix, dependencies?)`.
- Preserves: `persistSignature(value, keyPrefix): Promise<string | null>` for every unaffected caller.

- [ ] **Step 1: Write failing ownership and cleanup tests**

Add these imports to `e2e/money-pipeline.spec.ts`:

```ts
import {
  persistOwnedSignature,
  type SignatureStorageBucket,
} from "../src/lib/signature-storage";
```

Add this describe block before the first database-backed suite:

```ts
test.describe("Change-order signature object ownership", () => {
  const signatureDataUrl = "data:image/png;base64,AA==";

  test("owned signature discard removes the exact uploaded path once across concurrent calls", async () => {
    const uploaded: string[] = [];
    const uploadOptions: Array<{ contentType: string; upsert: false }> = [];
    const removed: string[][] = [];
    const bucket: SignatureStorageBucket = {
      async upload(path, _body, options) {
        uploaded.push(path);
        uploadOptions.push(options);
        return { error: null };
      },
      getPublicUrl(path) {
        return {
          data: {
            publicUrl: `https://example.supabase.co/storage/v1/object/public/project-files/${path}`,
          },
        };
      },
      async remove(paths) {
        removed.push([...paths]);
        return { error: null };
      },
    };

    const owned = await persistOwnedSignature(
      signatureDataUrl,
      "change-orders/test/client",
      {
        getBucket: () => bucket,
        now: () => 1_721_218_400_000,
        randomId: () => "owned-test-id",
      },
    );

    expect(uploaded).toEqual([
      "signatures/change-orders/test/client/1721218400000_owned-test-id.png",
    ]);
    expect(uploadOptions).toEqual([{ contentType: "image/png", upsert: false }]);
    expect(owned.url).toContain(uploaded[0]);

    await Promise.all([owned.discard(), owned.discard(), owned.discard()]);

    expect(removed).toEqual([[uploaded[0]]]);
  });

  test("missing public URL compensating-deletes the uploaded object", async () => {
    const uploaded: string[] = [];
    const removed: string[][] = [];
    const bucket: SignatureStorageBucket = {
      async upload(path) {
        uploaded.push(path);
        return { error: null };
      },
      getPublicUrl() {
        return { data: {} };
      },
      async remove(paths) {
        removed.push([...paths]);
        return { error: null };
      },
    };

    await expect(
      persistOwnedSignature(signatureDataUrl, "change-orders/test/client", {
        getBucket: () => bucket,
        now: () => 1_721_218_400_000,
        randomId: () => "url-failure-id",
      }),
    ).rejects.toThrow("Couldn't save your signature");

    expect(removed).toEqual([[uploaded[0]]]);
  });

  test("thrown public URL construction compensating-deletes the uploaded object", async () => {
    const uploaded: string[] = [];
    const removed: string[][] = [];
    const bucket: SignatureStorageBucket = {
      async upload(path) {
        uploaded.push(path);
        return { error: null };
      },
      getPublicUrl() {
        throw new Error("url construction failed");
      },
      async remove(paths) {
        removed.push([...paths]);
        return { error: null };
      },
    };

    await expect(
      persistOwnedSignature(signatureDataUrl, "change-orders/test/client", {
        getBucket: () => bucket,
        now: () => 1_721_218_400_000,
        randomId: () => "url-throw-id",
      }),
    ).rejects.toThrow("Couldn't save your signature");

    expect(removed).toEqual([[uploaded[0]]]);
  });

  test("late upload success after deadline is removed before the error returns", async () => {
    let settleUpload!: (result: { error: unknown | null }) => void;
    const removed: string[][] = [];
    const bucket: SignatureStorageBucket = {
      upload() {
        return new Promise((resolve) => { settleUpload = resolve; });
      },
      getPublicUrl() {
        throw new Error("must not construct a URL for a timed-out upload");
      },
      async remove(paths) {
        removed.push([...paths]);
        return { error: null };
      },
    };

    const persistence = persistOwnedSignature(
      signatureDataUrl,
      "change-orders/test/client",
      {
        getBucket: () => bucket,
        now: () => 1_721_218_400_000,
        randomId: () => "late-success-id",
        uploadTimeoutMs: 1,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    settleUpload({ error: null });

    await expect(persistence).rejects.toThrow("Couldn't save your signature");
    expect(removed).toEqual([[
      "signatures/change-orders/test/client/1721218400000_late-success-id.png",
    ]]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "Change-order signature object ownership"
```

Expected: failure during test compilation because `persistOwnedSignature` and `SignatureStorageBucket` do not exist.

- [ ] **Step 3: Implement the owned storage interface**

Add these types and helpers after `UPLOAD_TIMEOUT_MS` in `src/lib/signature-storage.ts`:

```ts
export type SignatureStorageBucket = {
    upload(
        path: string,
        body: Buffer,
        options: { contentType: string; upsert: false },
    ): Promise<{ error: unknown | null }>;
    getPublicUrl(path: string): { data: { publicUrl?: string | null } };
    remove(paths: string[]): Promise<{ error: unknown | null }>;
};

export type SignaturePersistenceDependencies = {
    getBucket: () => SignatureStorageBucket | null;
    now: () => number;
    randomId: () => string;
    uploadTimeoutMs: number;
};

export type OwnedSignature = {
    url: string | null;
    discard: () => Promise<void>;
};

const noDiscard = async () => {};

function defaultSignatureBucket(): SignatureStorageBucket | null {
    const supabase = getSupabase();
    return supabase
        ? supabase.storage.from(STORAGE_BUCKET) as unknown as SignatureStorageBucket
        : null;
}

function cleanupErrorType(error: unknown): string {
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
        return error.name;
    }
    return typeof error;
}
```

Replace the existing `persistSignature` implementation with the owned implementation and compatibility wrapper below. Retain `isOwnSignatureStorageUrl`, `SIGNATURE_DATA_URL_RE`, `MAX_SIGNATURE_BYTES`, and `UPLOAD_TIMEOUT_MS` unchanged.

```ts
export async function persistOwnedSignature(
    value: string | null | undefined,
    keyPrefix: string,
    dependencies: Partial<SignaturePersistenceDependencies> = {},
): Promise<OwnedSignature> {
    if (!value) return { url: null, discard: noDiscard };

    if (/^https?:\/\//i.test(value)) {
        if (isOwnSignatureStorageUrl(value)) {
            return { url: value, discard: noDiscard };
        }
        throw new Error("Invalid signature format");
    }

    const match = value.match(SIGNATURE_DATA_URL_RE);
    if (!match) throw new Error("Invalid signature format");

    const mime = match[1];
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) throw new Error("Invalid signature format");
    if (buffer.length > MAX_SIGNATURE_BYTES) throw new Error("Signature image too large");

    const getBucket = dependencies.getBucket ?? defaultSignatureBucket;
    const bucket = getBucket();
    if (!bucket) {
        const onPooler = (process.env.DATABASE_URL || "").includes("pgbouncer=true");
        if (onPooler) throw new Error("Signature storage is not configured");
        return { url: value, discard: noDiscard };
    }

    const now = dependencies.now ?? Date.now;
    const randomId = dependencies.randomId ?? randomUUID;
    const ext = mime === "jpeg" ? "jpg" : mime;
    const safePrefix = keyPrefix.replace(/[^a-zA-Z0-9/_-]/g, "_");
    const storagePath = `signatures/${safePrefix}/${now()}_${randomId()}.${ext}`;

    const uploadPromise = bucket.upload(storagePath, buffer, {
        contentType: `image/${mime}`,
        upsert: false,
    });
    const uploadTimeoutMs = dependencies.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineWon = false;
    let uploadResult: Awaited<typeof uploadPromise>;
    try {
        const timeout = new Promise<"deadline">((resolve) => {
            timer = setTimeout(
                () => resolve("deadline"),
                uploadTimeoutMs,
            );
        });
        const first = await Promise.race([uploadPromise, timeout]);
        if (first === "deadline") {
            deadlineWon = true;
            // Supabase upload has no proven cancellation signal. Observe settlement so
            // a late success can be removed before this attempt returns an error.
            uploadResult = await uploadPromise;
        } else {
            uploadResult = first;
        }
    } catch {
        throw new Error("Couldn't save your signature — please try again.");
    } finally {
        if (timer) clearTimeout(timer);
    }

    if (uploadResult.error) {
        throw new Error("Couldn't save your signature — please try again.");
    }

    let discardPromise: Promise<void> | undefined;
    const discard = () => {
        discardPromise ??= (async () => {
            const removal = await bucket.remove([storagePath]);
            if (removal.error) throw removal.error;
        })();
        return discardPromise;
    };

    if (deadlineWon) {
        try {
            await discard();
        } catch (error) {
            console.error("[signature-storage] cleanup failed", {
                operation: "discard-late-signature-upload",
                errorType: cleanupErrorType(error),
            });
        }
        throw new Error("Couldn't save your signature — please try again.");
    }

    let publicUrl: string | null | undefined;
    try {
        publicUrl = bucket.getPublicUrl(storagePath).data?.publicUrl;
    } catch {
        publicUrl = null;
    }
    if (!publicUrl) {
        try {
            await discard();
        } catch (error) {
            console.error("[signature-storage] cleanup failed", {
                operation: "discard-unaddressable-signature",
                errorType: cleanupErrorType(error),
            });
        }
        throw new Error("Couldn't save your signature — please try again.");
    }

    return { url: publicUrl, discard };
}

export async function persistSignature(
    value: string | null | undefined,
    keyPrefix: string,
): Promise<string | null> {
    return (await persistOwnedSignature(value, keyPrefix)).url;
}
```

- [ ] **Step 4: Run focused GREEN and typecheck**

Run:

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "Change-order signature object ownership"
npm run typecheck
```

Expected: four ownership tests pass; TypeScript exits 0.

- [ ] **Step 5: Commit the storage boundary**

```powershell
git add src/lib/signature-storage.ts e2e/money-pipeline.spec.ts
git diff --cached --check
git commit -m "feat(storage): add owned signature cleanup handle [PR-209]"
```

Expected: one commit containing only the storage boundary and its focused tests.

---

### Task 2: Compensate every unsuccessful approval attempt

**Files:**
- Create: `src/lib/change-order-approval.ts`
- Modify/Test: `e2e/money-pipeline.spec.ts:450-850`

**Interfaces:**
- Consumes: `persistOwnedSignature`, `OwnedSignature`, and unchanged `approveChangeOrderCore`.
- Produces: `ChangeOrderSignatureCleanupEvent`, `ChangeOrderApprovalDependencies`, and `approveChangeOrderWithSignature(id, input, dependencies?)`.
- Guarantees: errors and `null` results discard the attempt's handle; committed results retain it.

- [ ] **Step 1: Add the tracked object store and failing lifecycle tests**

Add these imports:

```ts
import {
  approveChangeOrderWithSignature,
  type ChangeOrderApprovalDependencies,
  type ChangeOrderSignatureCleanupEvent,
} from "../src/lib/change-order-approval";
```

Add `replaySent: "co-invariant-replay-sent"` to `COI`, include it in the `ids` cleanup array, and seed it independently:

```ts
await createChangeOrder(COI.replaySent, "Sent", 100, true);
```

Add this helper immediately after `rejectionMessage`:

```ts
function createTrackedSignatureStore() {
  const objects = new Set<string>();
  let sequence = 0;
  const persistSignature: ChangeOrderApprovalDependencies["persistSignature"] = async (
    _value,
    keyPrefix,
  ) => {
    const url = `https://signature.test/${keyPrefix}/${++sequence}.png`;
    objects.add(url);
    let discarded = false;
    return {
      url,
      async discard() {
        if (discarded) return;
        objects.delete(url);
        discarded = true;
      },
    };
  };
  return { objects, persistSignature };
}

const approvalInput = (signatureName: string) => ({
  signatureName,
  signatureDataUrl: "data:image/png;base64,AA==",
  approvedAt: new Date(),
});
```

Replace CO2 with this test:

```ts
test("CO2: invalid status removes the unused signature object", async () => {
  const approvalSignatures = createTrackedSignatureStore();
  const message = await rejectionMessage(approveChangeOrderWithSignature(
    COI.draftApproval,
    approvalInput("Invariant Signer"),
    { persistSignature: approvalSignatures.persistSignature },
  ));
  expect(message).toContain("must be Sent");
  expect(approvalSignatures.objects).toEqual(new Set());
  expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({
    where: { id: COI.draftApproval },
  })).status).toBe("Draft");
});
```

Replace CO4 with this test:

```ts
test("CO4: invalid subtotal removes the unused signature object", async () => {
  const approvalSignatures = createTrackedSignatureStore();
  const message = await rejectionMessage(approveChangeOrderWithSignature(
    COI.zeroSent,
    approvalInput("Zero Signer"),
    { persistSignature: approvalSignatures.persistSignature },
  ));
  expect(message).toContain("positive subtotal");
  expect(approvalSignatures.objects).toEqual(new Set());
  expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({
    where: { id: COI.zeroSent },
  })).status).toBe("Sent");
});
```

Replace CO5 with this concurrency test and add the replay test immediately after it:

```ts
test("CO5: concurrent losing approvals remove every unused signature object", async () => {
  const approvalSignatures = createTrackedSignatureStore();
  const attempts = await Promise.allSettled([
    approveChangeOrderWithSignature(
      COI.validSent,
      approvalInput("First Signer"),
      { persistSignature: approvalSignatures.persistSignature },
    ),
    approveChangeOrderWithSignature(
      COI.validSent,
      approvalInput("Second Signer"),
      { persistSignature: approvalSignatures.persistSignature },
    ),
  ]);

  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);

  const co = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
    where: { id: COI.validSent },
  });
  expect(co.status).toBe("Approved");
  expect(co.clientSignatureUrl).toBeTruthy();
  expect(approvalSignatures.objects).toEqual(new Set([co.clientSignatureUrl!]));
});

test("CO5A: replay removes only the replay upload", async () => {
  const approvalSignatures = createTrackedSignatureStore();
  const first = await approveChangeOrderWithSignature(
    COI.replaySent,
    approvalInput("Original Signer"),
    { persistSignature: approvalSignatures.persistSignature },
  );
  expect(first?.transitioned).toBe(true);
  const committed = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
    where: { id: COI.replaySent },
  });
  expect(approvalSignatures.objects).toEqual(new Set([committed.clientSignatureUrl!]));

  const message = await rejectionMessage(approveChangeOrderWithSignature(
    COI.replaySent,
    approvalInput("Replay Signer"),
    { persistSignature: approvalSignatures.persistSignature },
  ));

  expect(message).toContain("must be Sent");
  expect(approvalSignatures.objects).toEqual(new Set([committed.clientSignatureUrl!]));
  expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({
    where: { id: COI.replaySent },
  })).clientSignatureUrl).toBe(committed.clientSignatureUrl);
});
```

Add transaction-failure, missing-row, and cleanup-failure tests:

```ts
test("CO5B: transaction failure removes the attempt and preserves the original error", async () => {
  const approvalSignatures = createTrackedSignatureStore();
  const transactionError = new Error("injected transaction failure");
  let caught: unknown;
  try {
    await approveChangeOrderWithSignature(
      COI.rawDraft,
      approvalInput("Failed Transaction Signer"),
      {
        persistSignature: approvalSignatures.persistSignature,
        approveCore: async () => { throw transactionError; },
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(transactionError);
  expect(approvalSignatures.objects).toEqual(new Set());
});

test("CO5C: missing change order removes the attempt before returning null", async () => {
  const approvalSignatures = createTrackedSignatureStore();
  const result = await approveChangeOrderWithSignature(
    "co-invariant-missing",
    approvalInput("Missing Signer"),
    { persistSignature: approvalSignatures.persistSignature },
  );
  expect(result).toBeNull();
  expect(approvalSignatures.objects).toEqual(new Set());
});

test("CO5D: cleanup failure telemetry is sanitized and the primary error wins", async () => {
  const primaryError = new Error("primary approval failure");
  const events: ChangeOrderSignatureCleanupEvent[] = [];
  let caught: unknown;
  try {
    await approveChangeOrderWithSignature(
      COI.rawDraft,
      approvalInput("Sensitive Customer Name"),
      {
        persistSignature: async () => ({
          url: "https://signature.test/private-object.png",
          discard: async () => {
            throw Object.assign(new Error("private-object.png"), {
              code: "storage_delete_failed",
              status: 503,
            });
          },
        }),
        approveCore: async () => { throw primaryError; },
        reportCleanupFailure: (event) => events.push(event),
      },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primaryError);
  expect(events).toEqual([{
    operation: "discard-rejected-change-order-signature",
    changeOrderId: COI.rawDraft,
    errorType: "Error",
    errorCode: "storage_delete_failed",
    status: 503,
  }]);
  expect(JSON.stringify(events)).not.toContain("private-object");
  expect(JSON.stringify(events)).not.toContain("Sensitive Customer Name");
});

test("CO5E: throwing cleanup reporter cannot replace the primary error", async () => {
  const primaryError = new Error("primary approval failure");
  let reporterCalls = 0;
  let caught: unknown;
  try {
    await approveChangeOrderWithSignature(
      COI.rawDraft,
      approvalInput("Reporter Failure Signer"),
      {
        persistSignature: async () => ({
          url: "https://signature.test/private-object.png",
          discard: async () => { throw new Error("cleanup failed"); },
        }),
        approveCore: async () => { throw primaryError; },
        reportCleanupFailure: () => {
          reporterCalls += 1;
          throw new Error("telemetry backend failed");
        },
      },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primaryError);
  expect(reporterCalls).toBe(1);
});
```

- [ ] **Step 2: Run the cleanup tests and verify RED**

Run:

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "CO2:|CO4:|CO5"
```

Expected: failure because `src/lib/change-order-approval.ts` does not exist.

- [ ] **Step 3: Implement the approval coordinator**

Create `src/lib/change-order-approval.ts` with this complete content:

```ts
import { approveChangeOrderCore } from "./change-order-core";
import { persistOwnedSignature } from "./signature-storage";

export type ChangeOrderSignatureCleanupEvent = {
    operation: "discard-rejected-change-order-signature";
    changeOrderId: string;
    errorType: string;
    errorCode?: string;
    status?: number;
};

export type ChangeOrderApprovalDependencies = {
    persistSignature: typeof persistOwnedSignature;
    approveCore: typeof approveChangeOrderCore;
    reportCleanupFailure: (event: ChangeOrderSignatureCleanupEvent) => void;
};

type ChangeOrderApprovalInput = {
    signatureName: string;
    signatureDataUrl: string;
    approvedAt: Date;
};

function safeIdentifier(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
        ? value
        : undefined;
}

function cleanupEvent(changeOrderId: string, error: unknown): ChangeOrderSignatureCleanupEvent {
    const record = typeof error === "object" && error !== null
        ? error as Record<string, unknown>
        : {};
    const errorType = error instanceof Error
        ? safeIdentifier(error.name) ?? "Error"
        : typeof error;
    const errorCode = safeIdentifier(record.code);
    const status = typeof record.status === "number"
        && Number.isInteger(record.status)
        && record.status >= 100
        && record.status <= 599
        ? record.status
        : undefined;
    return {
        operation: "discard-rejected-change-order-signature",
        changeOrderId,
        errorType,
        ...(errorCode ? { errorCode } : {}),
        ...(status ? { status } : {}),
    };
}

const defaultDependencies: ChangeOrderApprovalDependencies = {
    persistSignature: persistOwnedSignature,
    approveCore: approveChangeOrderCore,
    reportCleanupFailure: (event) => {
        console.error("[approveChangeOrder] signature cleanup failed", event);
    },
};

export async function approveChangeOrderWithSignature(
    id: string,
    input: ChangeOrderApprovalInput,
    overrides: Partial<ChangeOrderApprovalDependencies> = {},
) {
    const dependencies = { ...defaultDependencies, ...overrides };
    const owned = await dependencies.persistSignature(
        input.signatureDataUrl,
        `change-orders/${id}/client`,
    );

    const discard = async () => {
        try {
            await owned.discard();
        } catch (error) {
            try {
                dependencies.reportCleanupFailure(cleanupEvent(id, error));
            } catch (reporterError) {
                try {
                    console.error("[approveChangeOrder] cleanup telemetry failed", {
                        operation: "report-signature-cleanup-failure",
                        changeOrderId: id,
                        errorType: reporterError instanceof Error
                            ? safeIdentifier(reporterError.name) ?? "Error"
                            : typeof reporterError,
                    });
                } catch {
                    // Telemetry must never replace the primary approval error.
                }
            }
        }
    };

    try {
        const approval = await dependencies.approveCore(id, {
            signatureName: input.signatureName,
            clientSignatureUrl: owned.url,
            approvedAt: input.approvedAt,
        });
        if (!approval) {
            await discard();
            return null;
        }
        return approval;
    } catch (error) {
        await discard();
        throw error;
    }
}
```

- [ ] **Step 4: Run focused GREEN and the full invariant suite**

Run:

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "CO2:|CO4:|CO5"
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "Money pipeline: change-order lifecycle invariants"
npm run typecheck
```

Expected: focused cleanup cases pass; all change-order invariant tests pass; TypeScript exits 0.

- [ ] **Step 5: Commit the coordinator**

```powershell
git add src/lib/change-order-approval.ts e2e/money-pipeline.spec.ts
git diff --cached --check
git commit -m "fix(change-orders): clean rejected approval signatures [PR-209]"
```

---

### Task 3: Route the authenticated server action through the coordinator

**Files:**
- Modify: `src/lib/actions.ts:14-19` and `src/lib/actions.ts:7683-7745`
- Test: `e2e/money-pipeline.spec.ts`

**Interfaces:**
- Consumes: `approveChangeOrderWithSignature` from Task 2.
- Preserves: `approveChangeOrder(id, signatureName, userAgent, signatureDataUrl?)`, its auth/ownership checks, automation, revalidation, and return shape.

- [ ] **Step 1: Add a failing source-boundary regression test**

Add imports to `e2e/money-pipeline.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

Add this test to the change-order invariant suite:

```ts
test("CO17: the server action delegates signature ownership to the coordinator", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
  const start = source.indexOf("export async function approveChangeOrder(");
  const end = source.indexOf("\nexport async function ", start + 1);
  const actionSource = source.slice(start, end === -1 ? undefined : end);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(actionSource).toContain("await approveChangeOrderWithSignature(");
  expect(actionSource).not.toContain("await persistSignature(");
  expect(actionSource).not.toContain("await approveChangeOrderCore(");
});
```

- [ ] **Step 2: Run the source-boundary test and verify RED**

Run:

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "CO17:"
```

Expected: failure because the action still calls `persistSignature` and `approveChangeOrderCore` directly.

- [ ] **Step 3: Replace only the approval lifecycle call path**

Add this import in `src/lib/actions.ts`:

```ts
import { approveChangeOrderWithSignature } from "./change-order-approval";
```

Remove `approveChangeOrderCore` from the `change-order-core` import while retaining `deleteChangeOrderCore` and `updateChangeOrderCore`. Keep the `persistSignature` import because other signing actions still use it.

Replace the upload/core block inside `approveChangeOrder` with:

```ts
    const approvedAt = new Date();
    const approval = await approveChangeOrderWithSignature(id, {
        signatureName: normalizedSignatureName,
        signatureDataUrl,
        approvedAt,
    });
    if (!approval) return null;
    const { co, transitioned } = approval;
```

Do not move the auth checks, post-commit automation, revalidation, or return statements.

- [ ] **Step 4: Run GREEN, invariants, and typecheck**

Run:

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "CO17:"
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "Money pipeline: change-order lifecycle invariants"
npm run typecheck
```

Expected: source-boundary test passes; full change-order invariant suite passes; TypeScript exits 0.

- [ ] **Step 5: Commit the action wiring**

```powershell
git add src/lib/actions.ts e2e/money-pipeline.spec.ts
git diff --cached --check
git commit -m "refactor(change-orders): delegate approval ownership [PR-209]"
```

---

### Task 4: Publish the exact health-check contract

**Files:**
- Modify: `src/proxy.ts:20-120`
- Modify: `src/app/api/health/route.ts:1-8`
- Modify/Test: `e2e/auth-status.spec.ts`
- Modify: `.specs/PB-health-001-health-endpoint.md`

**Interfaces:**
- Produces: anonymous `GET /api/health` returning only `{ status: "ok", ts }` with `Cache-Control: no-store, max-age=0`.
- Preserves: `/api/version` as public deployment identity and every existing protected proxy path.

- [ ] **Step 1: Add the anonymous production-proxy test**

Add this top-level describe block before `staff status revokes existing sessions` in `e2e/auth-status.spec.ts`:

```ts
test.describe("public deployment probe", () => {
  test("only the exact /api/health path bypasses production authentication", async ({ playwright }) => {
    const baseURL = test.info().project.use.baseURL as string;
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const health = await anonymous.get("/api/health", { maxRedirects: 0 });
      expect(health.status()).toBe(200);
      expect(health.headers()["cache-control"]).toContain("no-store");
      const body = await health.json();
      expect(Object.keys(body).sort()).toEqual(["status", "ts"]);
      expect(body.status).toBe("ok");
      const timestamp = Date.parse(body.ts);
      expect(Number.isNaN(timestamp)).toBe(false);
      expect(Math.abs(Date.now() - timestamp)).toBeLessThan(10_000);

      const nested = await anonymous.get("/api/health/private", { maxRedirects: 0 });
      const protectedApi = await anonymous.post("/api/admin/stripe-backfill", {
        data: "not-json",
        headers: { "content-type": "application/json" },
        maxRedirects: 0,
      });
      if (process.env.CI) {
        expect(nested.status()).toBe(307);
        expect(nested.headers().location).toContain("/login");
        expect(protectedApi.status()).toBe(307);
        expect(protectedApi.headers().location).toContain("/login");
      } else {
        expect(nested.status()).toBe(404);
        expect(protectedApi.status()).toBe(403);
      }
    } finally {
      await anonymous.dispose();
    }
  });
});
```

- [ ] **Step 2: Build and run the production proxy test to verify RED**

Run:

```powershell
npm run build
$env:CI = '1'
try {
  npx playwright test e2e/auth-status.spec.ts --project=chromium --grep "public deployment probe"
} finally {
  Remove-Item Env:\CI -ErrorAction SilentlyContinue
}
```

Expected: `/api/health` returns 307 instead of 200.

- [ ] **Step 3: Add the exact proxy exception and uncached response**

Change `PUBLIC_PROXY_BYPASS_PATTERN` in `src/proxy.ts` so the exact health path is a top-level alternative:

```ts
const PUBLIC_PROXY_BYPASS_PATTERN = /^\/(?:api\/health$|api\/(?:auth|cron|twilio|webhook|payments|portal|integrations|mcp(?:\/|$)|version|pdf\/(?:estimates|invoices)|sub-portal|mobile)(?:\/|$)|login(?:\/|$)|portal(?:\/|$)|sub-portal(?:\/|$)|share(?:\/|$)|_next\/(?:static|image)(?:\/|$)|favicon\.ico$|.*\.(?:png|jpg|svg|webmanifest)$)/;
```

Add `api/health` to the matcher documentation and change the matcher source to:

```ts
"/((?!api/health$|api/auth|api/cron|api/twilio|api/webhook|api/payments|api/portal|api/integrations|api/mcp/|api/version|api/pdf/estimates|api/pdf/invoices|api/sub-portal|api/mobile|login|portal|sub-portal|share|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg|.*\\.webmanifest).*)",
```

Replace `src/app/api/health/route.ts` with:

```ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", ts: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
```

- [ ] **Step 4: Update the health specification**

Update `.specs/PB-health-001-health-endpoint.md` with these exact contract changes:

```markdown
**Status:** implemented; proxy contract corrected 2026-07-17

## Production contract

- Supported probe: `https://probuild.goldentouchremodeling.com/api/health`
- Authentication: none for the exact `/api/health` path
- Response: HTTP 200 with `{ "status": "ok", "ts": "<ISO 8601 timestamp>" }`
- Cache policy: `Cache-Control: no-store, max-age=0`
- Dependency scope: web-process deployment probe only; no database, storage, or third-party readiness claim
- `/api/version`: public deployment identity for stale-client detection, not readiness

## Proxy requirement

Both proxy matching paths exclude exactly `/api/health`. Nested paths such as `/api/health/private` remain protected; the exception does not widen another `/api` namespace.
```

Revise the old context statement that the endpoint does not exist, remove caching headers from Non-Goals, and replace the post-deploy URL with the supported production URL above.

- [ ] **Step 5: Rebuild and run GREEN under the production proxy**

Run:

```powershell
npm run build
$env:CI = '1'
try {
  npx playwright test e2e/auth-status.spec.ts --project=chromium --grep "public deployment probe"
} finally {
  Remove-Item Env:\CI -ErrorAction SilentlyContinue
}
```

Expected: exact health returns 200; nested health and protected API return 307; one test passes.

- [ ] **Step 6: Commit the health contract**

```powershell
git add src/proxy.ts src/app/api/health/route.ts e2e/auth-status.spec.ts .specs/PB-health-001-health-endpoint.md
git diff --cached --check
git commit -m "fix(health): expose exact public deployment probe [PB-health-001]"
```

---

### Task 5: Execute full validation and independent gates

**Files:**
- Review only: all files changed since `origin/main`
- Modify only if a verified test or review finding requires a focused correction

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: fresh command evidence plus independent Codex peer-review, QAS, and security decisions.

- [ ] **Step 1: Verify repository and credential hygiene without printing secrets**

Run:

```powershell
git status --short
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
git grep -n "VERCEL_TOKEN" -- ':!package-lock.json'
```

Expected: clean worktree; no diff whitespace errors; only planned files; no newly added credential value or repository secret reference.

- [ ] **Step 2: Run focused cleanup coverage**

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium --grep "Change-order signature object ownership|CO2:|CO4:|CO5|CO17:"
```

Expected: all selected ownership, invalid-status, invalid-subtotal, concurrent-loser, replay, transaction-failure, missing-row, cleanup-telemetry, and action-boundary tests pass.

- [ ] **Step 3: Run the complete money-pipeline spec**

```powershell
npx playwright test e2e/money-pipeline.spec.ts --project=chromium
```

Expected: every test in `e2e/money-pipeline.spec.ts` passes with zero failures.

- [ ] **Step 4: Run typecheck and production build separately**

```powershell
npm run typecheck
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Run full auth-status coverage with the production server**

```powershell
$env:CI = '1'
try {
  npx playwright test e2e/auth-status.spec.ts --project=chromium
} finally {
  Remove-Item Env:\CI -ErrorAction SilentlyContinue
}
```

Expected: public health and existing disabled-session/auth-boundary tests pass under `next start`.

- [ ] **Step 6: Run dependency and secret-name checks**

```powershell
npm audit --audit-level=high
git grep -n -E "(sk_live|pk_live|password=|VERCEL_TOKEN=)" -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.md'
```

Expected: no high/critical audit finding introduced by this branch and no committed credential value. Record pre-existing findings separately instead of modifying unrelated dependencies.

- [ ] **Step 7: Dispatch three independent read-only reviewers**

Dispatch reviewers concurrently against `C:\tmp\probuild-pr209-security-followup`:

1. **codex-peer-review:** inspect `origin/main...HEAD` for correctness, regressions, type/API issues, and missing tests.
2. **QAS:** independently run the focused and full acceptance coverage and map results to every requested case.
3. **Security Engineer:** audit object ownership, cleanup scope, SSRF/storage behavior, sanitized logging, exact proxy exposure, credential-reference hygiene, and OWASP-relevant changes.

Each reviewer must report file/line evidence and must not edit files, deploy, push, or manage branches.

- [ ] **Step 8: Resolve verified findings and rerun affected gates**

For every actionable finding, reproduce it first, add or adjust a failing test, make the smallest correction, rerun the focused check, then rerun Steps 2-5. For a storage/approval correction, stage the bounded storage set; for a health/proxy correction, stage the bounded health set. Run both `git add` commands only when both subsystems changed:

```powershell
git add src/lib/signature-storage.ts src/lib/change-order-approval.ts src/lib/actions.ts e2e/money-pipeline.spec.ts
git add src/proxy.ts src/app/api/health/route.ts e2e/auth-status.spec.ts .specs/PB-health-001-health-endpoint.md
git diff --cached --check
git commit -m "fix(security): address independent review findings [PR-209]"
```

If there are no actionable findings, do not create an empty commit.

- [ ] **Step 9: Preserve branch and deployment boundaries**

Run read-only checks:

```powershell
git -C 'C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site' status --short
git branch --contains f4ad332928c0100acde331d0e9fd06d1e0546d9b
git ls-remote --heads origin codex/pr-205-change-order-invariants
```

Expected: report the canonical dirty state and stale branch facts without deleting, switching, resetting, deploying, or pushing anything.

- [ ] **Step 10: Produce the handoff**

Report:

- commits and exact changed files;
- credential rotation verification evidence without token values;
- focused/full test counts and command exit codes;
- build/typecheck results;
- peer-review, QAS, and security decisions plus resolved findings;
- current production probe behavior versus the branch's intended behavior;
- explicit statement that no deployment, push, or branch deletion occurred.
