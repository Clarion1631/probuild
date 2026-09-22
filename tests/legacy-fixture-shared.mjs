/**
 * The queue, the URLs and the extraction used BOTH to capture the legacy
 * fixture from `origin/claude/weak-net-distinct-refs` and to check the current
 * render against it. One definition, so the two halves cannot drift.
 *
 * An entry is [name, filters, queueFactory?]; the factory defaults to
 * `legacyQueue`.
 */
import { parseReceiptFilters } from "../src/app/automation/receipts-filters";

/** Only the group panels: not the scope note, the stat tiles or the chip row. */
export function groupSections(html) {
    return (html.match(/<section class="hui-card overflow-hidden">[\s\S]*?<\/section>/g) ?? []).join("\n");
}

export const LEGACY_URLS = [
    ["group=needs-job", { group: "needs-job", projectId: null, owner: null }],
    ["group=needs-review", { group: "needs-review", projectId: null, owner: null }],
    ["group=booking", { group: "booking", projectId: null, owner: null }],
    ["group=booked-today", { group: "booked-today", projectId: null, owner: null }],
    ["group=duplicates", { group: "duplicates", projectId: null, owner: null }],
    ["group=exceptions", { group: "exceptions", projectId: null, owner: null }],
    ["group=uncertain-cards", { group: "uncertain-cards", projectId: null, owner: null }],
    ["group=missing-receipts", { group: "missing-receipts", projectId: null, owner: null }],
    ["group=missing-receipts&owner=Richard", { group: "missing-receipts", projectId: null, owner: "Richard" }],
    ["all groups", { group: null, projectId: null, owner: null }],
    // Through REAL URL parsing, and with the queue narrowed the way the loader
    // narrows it. `?owner=Richard` names an owner, which the To-do view cannot
    // honour, so this URL draws the groups exactly as it always did.
    ["owner=Richard (parsed)", parseReceiptFilters({ tab: "receipts", owner: "Richard" }), () => richardOnlyQueue()],
];

function intake(id, over = {}) {
    return {
        id, state: "NEEDS_REVIEW", stateReason: null, source: "chat",
        projectId: null, projectName: null, costCodeId: null,
        vendor: `Vendor ${id}`, txnDate: "2026-09-18", totalCents: -4_000,
        fileName: `${id}.pdf`, storagePath: `receipts/intake/${id}.pdf`,
        duplicateOfId: null, qbPurchaseId: null, postVoidQbPurchaseId: null,
        attempts: 0, lastError: null, nextRetryAt: null, bookedAt: null,
        createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z",
        ...over,
    };
}

function request(id, over = {}) {
    return {
        id, version: 1, reasonHash: `hash-${id}`, acknowledged: false,
        targetKey: `bank-${id}`, owner: "CJ", ownerAssigned: false,
        cardTail: "8516", postedDate: "2026-09-02", amountCents: -4_000,
        payee: "THE ROCKERY NW", rawDescriptor: "THE ROCKERY NW POS DEB",
        fingerprint: `fp-${id}`, threadName: null, outreachHold: null,
        resolution: null, pdfUrl: null,
        ...over,
    };
}

/**
 * One row of most shapes, with `txnDate` set everywhere and `nextRetryAt`
 * unset: the two approved differences that would otherwise show up as date
 * text are exercised by their own tests, not smuggled into this one.
 */
/**
 * What `fetchReceiptQueue` returns for `?owner=Richard`: the owner filter is
 * applied in the LOADER, not the renderer, so the narrowing has to be in the
 * fixture's data rather than in the component under test.
 */
export function richardOnlyQueue() {
    const whole = legacyQueue();
    const mine = whole.missingReceipts.filter(row => row.owner === "Richard");
    return {
        ...whole,
        missingReceipts: mine,
        counts: { ...whole.counts, missingReceiptsShown: mine.length },
    };
}

export function legacyQueue() {
    const groups = {
        needsJob: [
            intake("nj", { state: "NEEDS_JOB" }),
            // No read date, and an evening arrival: the base printed the UTC
            // calendar day here, which is tomorrow.
            intake("nj-nodate", { state: "NEEDS_JOB", txnDate: null, createdAt: "2026-09-19T03:30:00.000Z" }),
        ],
        needsReview: [
            intake("nr-weak", { stateReason: "weak-dup:abc" }),
            intake("nr-unread", { stateReason: "unreadable" }),
            intake("nr-orphan", { postVoidQbPurchaseId: "qb-9", stateReason: "booked-after-void" }),
        ],
        // A retry time the base rendered in UTC, so 8:30pm Pacific read as
        // tomorrow morning.
        booking: [intake("bk", { state: "BOOKING", nextRetryAt: "2026-09-21T03:30:00.000Z" })],
        bookedToday: [intake("bt", { state: "BOOKED", qbPurchaseId: "qb-1" })],
        duplicates: [intake("dp", { state: "DUPLICATE", duplicateOfId: "nj" })],
        exceptions: [intake("exc", { postVoidQbPurchaseId: "qb-2" })],
        uncertainCards: [{
            id: "uc", owner: "CJ", pacificDate: "2026-09-19", items: 2,
            attempts: 1, lastError: null, updatedAt: "2026-09-19T12:00:00.000Z",
        }],
        missingReceipts: [
            request("m-cj"),
            request("m-rich", { owner: "Richard", cardTail: "6098", payee: "HOME DEPOT" }),
            request("m-unattr", { owner: "unattributed", cardTail: null, payee: "SUNBELT RENTALS" }),
            request("m-held", { outreachHold: "existing-evidence-review", payee: "TAPANI" }),
            request("m-memo", { resolution: "memo-signed", pdfUrl: "https://memo.test/x.pdf", payee: "ACE" }),
        ],
    };
    return {
        ...groups,
        counts: {
            needsJob: groups.needsJob.length, needsReview: groups.needsReview.length,
            booking: groups.booking.length, bookedToday: groups.bookedToday.length,
            duplicates: groups.duplicates.length, exceptions: groups.exceptions.length,
            uncertainCards: groups.uncertainCards.length,
            // Deliberately LARGER than the list, so the capped "Showing…" line
            // renders on both sides and its rewording is exercised.
            missingReceipts: 109,
            missingReceiptsShown: groups.missingReceipts.length,
        },
    };
}
