/**
 * Integration settings storage via an encrypted PostgreSQL table.
 * Stores OAuth tokens and settings for QB, Gusto, etc. securely.
 * Utilizes a Prisma transaction and AES-256-GCM encryption.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { encryptObject, decryptObject } from "./crypto";

/**
 * Either the base client or a transaction client. The payroll export reads the
 * Gusto employee mappings through its OWN transaction, so the row it hashes is
 * the row its FOR SHARE lock is holding — a read on the global client would be
 * a second connection outside that transaction and could see a different blob.
 */
export type IntegrationClient = typeof prisma | Prisma.TransactionClient;

export interface QBSettings {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    realmId?: string;
    connectedAt?: string;
    glMappings?: Record<string, string>; // costCodeId -> QB GL account name
    serviceItemId?: string; // QBO "Construction Services" item used on pushed invoice lines
}

export interface GustoSettings {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    companyId?: string;
    connectedAt?: string;
    employeeMappings?: Record<string, string>; // userId -> gusto_employee_uuid
}

export interface IntegrationSettings {
    quickbooks?: QBSettings;
    gusto?: GustoSettings;
}

// Single row ID for storing all system integrations safely
const INTEGRATION_ROW_ID = "system_settings";

/**
 * Advisory-lock key for read-modify-write of the integration blob.
 *
 * `SELECT ... FOR UPDATE` alone is not enough: on a fresh install the row does
 * not exist yet, and FOR UPDATE cannot lock a row nobody has inserted — two
 * concurrent first-time connects would both read "no row" and both insert. The
 * advisory lock covers the row's ABSENCE as well as its presence, exactly like
 * acquirePayrollLockCreationLock in payroll-period.ts. Both are taken.
 */
const INTEGRATION_LOCK_KEY = `integration:${INTEGRATION_ROW_ID}`;

/**
 * Read the decrypted blob.
 *
 * A DATABASE failure PROPAGATES. It used to be swallowed into `{}`, which every
 * caller then read as "nothing is connected": the QuickBooks rail reported
 * itself disconnected during a transient outage, and — the payroll case — the
 * Gusto export built a CSV with every gustoEmployeeId blank, hashed it, and was
 * ready to freeze a pay period around it. An empty answer and an unavailable
 * one are not the same fact and must not share a return value.
 *
 * An UNDECRYPTABLE blob is still tolerated, because that is a different
 * question: a row written under a rotated INTEGRATION key is unreadable
 * forever, and treating it as fatal would brick every read and every save (this
 * exact failure blocked the first QuickBooks OAuth connect, Jun 2026).
 */
async function readSettings(client: IntegrationClient = prisma): Promise<IntegrationSettings> {
    const row = await client.integration.findUnique({
        where: { id: INTEGRATION_ROW_ID }
    });
    if (!row || !row.settings) return {};
    return decryptOrReset(row.settings);
}

export async function getIntegrationSettings(client: IntegrationClient = prisma): Promise<IntegrationSettings> {
    return readSettings(client);
}

export async function getQBSettings(client: IntegrationClient = prisma): Promise<QBSettings> {
    const settings = await readSettings(client);
    return settings.quickbooks || { connected: false };
}

// Decrypt the stored blob, but never let an undecryptable row (e.g. written
// under a rotated INTEGRATION key) brick all future saves — start fresh instead.
// This exact failure blocked the first QuickBooks OAuth connect (Jun 2026).
function decryptOrReset(ciphertext: string): IntegrationSettings {
    try {
        return decryptObject(ciphertext) as IntegrationSettings;
    } catch (err) {
        console.error("[integration-store] Existing settings undecryptable — resetting:", err);
        return {};
    }
}

/**
 * SERIALIZED read-modify-write of the one encrypted blob.
 *
 * QuickBooks and Gusto share a single row, so every save rewrites the WHOLE
 * document — including the other integration's fields. Read-then-upsert without
 * a lock loses one of two concurrent writes outright: both transactions read the
 * same blob, both merge their own patch into it, and the second upsert
 * overwrites the first with a document derived from a value that is already
 * stale. Under READ COMMITTED the upsert's row lock does not save it — it
 * serialises the WRITES, not the read the writes were computed from. A Gusto
 * OAuth callback landing next to a QuickBooks token refresh could therefore
 * disconnect QuickBooks, silently.
 *
 * The lock is taken BEFORE the read, so the read is inside the critical section.
 *
 * NOTHING is caught here. A save that could not persist must not return, because
 * every caller treats "returned" as "committed" and answers the user with a
 * success (the mapping endpoint's `{ success: true }`, the OAuth callback's
 * `?success=1`). A silent failure there means the mapping deciding whose hours
 * are filed under which Gusto employee looks saved and is not.
 */
async function updateIntegrationSettings(
    apply: (current: IntegrationSettings) => IntegrationSettings
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        // Covers the row's absence (see INTEGRATION_LOCK_KEY)...
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, INTEGRATION_LOCK_KEY);
        // ...and the row itself. Stated precisely, because it is easy to
        // overclaim: the advisory lock above already serialises every writer
        // that comes through HERE, and the upsert below already conflicts with
        // the payroll export's FOR SHARE on this row all by itself. This line is
        // defence in depth — it makes the read-modify-write atomic against any
        // writer that ever touches "Integration" directly instead of through
        // this function, and it loses such a race BEFORE the merge is computed
        // rather than at the upsert, with the stale document already built.
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Integration" WHERE "id" = $1 FOR UPDATE`, INTEGRATION_ROW_ID);

        const settings = await readSettings(tx);
        const encrypted = encryptObject(apply(settings));

        await tx.integration.upsert({
            where: { id: INTEGRATION_ROW_ID },
            create: { id: INTEGRATION_ROW_ID, settings: encrypted },
            update: { settings: encrypted }
        });
    });
}

export async function saveQBSettings(qb: Partial<QBSettings>): Promise<void> {
    await updateIntegrationSettings((settings) => ({
        ...settings,
        quickbooks: { ...(settings.quickbooks || { connected: false }), ...qb },
    }));
}

export async function getGustoSettings(client: IntegrationClient = prisma): Promise<GustoSettings> {
    const settings = await readSettings(client);
    return settings.gusto || { connected: false };
}

export async function saveGustoSettings(gusto: Partial<GustoSettings>): Promise<void> {
    await updateIntegrationSettings((settings) => ({
        ...settings,
        gusto: { ...(settings.gusto || { connected: false }), ...gusto },
    }));
}
