import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { DispatchChatMessage } from './dispatch-chat-transport';
import { displayEndDate } from './schedule-dates';

export type VerifiedDispatchRecipient = {
    userId: string;
    spaceName: string;
    spaceType: 'DIRECT_MESSAGE';
    verifiedAt: string;
    principalId: string;
};
export type DispatchDeliveryConfig = {
    enabled?: boolean;
    approvedDeliveryIds: readonly string[];
    recipients: readonly VerifiedDispatchRecipient[];
};
type Envelope = DispatchChatMessage & { principalId: string; userId: string };
type Sender = (message: Envelope) => Promise<string>;

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatPlan(payload: Record<string, unknown>, userId: string): string | null {
    if (!Array.isArray(payload.tasks) || !payload.tasks.length) return null;
    const lines = ["I'm Justin's AI assistant. Here is your published ProBuild dispatch update:"];
    for (const value of payload.tasks) {
        const task = record(value);
        if (typeof task.projectName !== 'string' || typeof task.name !== 'string' || typeof task.startDate !== 'string' || typeof task.endDate !== 'string' || !Array.isArray(task.assignments)) return null;
        const assigned = task.assignments.some(value => record(value).userId === userId);
        lines.push(`${assigned ? 'Assigned' : 'Removed from assignment'}: ${task.projectName} — ${task.name} (${task.startDate} to ${displayEndDate(task.startDate, task.endDate, typeof task.type === 'string' ? task.type : 'task')})`);
        if (assigned) {
            if (task.scheduledTime) lines.push(`Start: ${String(task.scheduledTime)} Pacific`);
            if (task.doneWhen) lines.push(`Instructions: ${String(task.doneWhen)}`);
            if (task.blockedReason) lines.push(`Blocker: ${String(task.blockedReason)}`);
        }
    }
    lines.push('Open ProBuild for your plan and record actual worked time.');
    const text = lines.join('\n');
    return Buffer.byteLength(text, 'utf8') <= 30_000 ? text : null;
}

/** No scheduler or environment activation. The caller must explicitly approve
 * individual delivery IDs and supply mappings verified for the pinned principal.
 * Frozen transport state prevents retries from moving to a different DM/account.
 */
export async function deliverDispatchById(
    db: PrismaClient,
    id: string,
    config: DispatchDeliveryConfig,
    send: Sender,
): Promise<string> {
    if (!config.enabled) return 'disabled';
    if (!config.approvedDeliveryIds.includes(id)) return 'not_approved';
    const claimToken = randomUUID();
    const now = new Date();
    const result = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "ChatDelivery" WHERE "id" = ${id} FOR UPDATE`;
        const row = await tx.chatDelivery.findUnique({ where: { id } });
        if (!row || row.kind !== 'dispatch_publication') return { status: 'not_found' };
        if (row.status === 'PROCESSED') return { status: 'already_processed' };
        if (row.status === 'PROCESSING' && row.processingStartedAt && row.processingStartedAt.getTime() > now.getTime() - 60_000) return { status: 'busy' };
        if (!['PENDING', 'FAILED', 'PROCESSING'].includes(row.status) || row.attempts >= 5) return { status: 'needs_review' };
        const payload = record(row.payload);
        const userId = record(payload.recipient).userId;
        if (typeof userId !== 'string' || row.destination !== `user:${userId}`) return { status: 'invalid_recipient' };
        const mappings = config.recipients.filter(candidate => candidate.userId === userId);
        const mapping = mappings[0];
        if (mappings.length !== 1 || mapping.spaceType !== 'DIRECT_MESSAGE' || !/^spaces\/[A-Za-z0-9_-]+$/.test(mapping.spaceName) || !Number.isFinite(Date.parse(mapping.verifiedAt)) || !mapping.principalId) return { status: 'unverified_mapping' };
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        if (user?.status !== 'ACTIVATED') return { status: 'inactive_recipient' };
        const existing = record(payload.deliveryTransport);
        if (Object.keys(existing).length && (existing.spaceName !== mapping.spaceName || existing.principalId !== mapping.principalId || existing.userId !== userId)) return { status: 'mapping_changed' };
        const text = formatPlan(payload, userId);
        if (!text) return { status: 'missing_snapshot' };
        const identity = createHash('sha256').update(id).digest('hex').slice(0, 48);
        const envelope: Envelope = { userId, principalId: mapping.principalId, spaceName: mapping.spaceName, messageId: `client-${identity}`, requestId: `dispatch-${identity}`, text };
        if (Object.keys(existing).length && JSON.stringify(existing) !== JSON.stringify(envelope)) {
            // JSONB reorders keys, so compare every field explicitly.
            if (Object.entries(envelope).some(([key, value]) => existing[key] !== value)) return { status: 'payload_changed' };
        }
        await tx.chatDelivery.update({ where: { id }, data: {
            status: 'PROCESSING', claimToken, processingStartedAt: now, attempts: { increment: 1 }, lastError: null,
            payload: { ...payload, deliveryTransport: { ...envelope } } as Prisma.InputJsonValue,
        } });
        return { envelope };
    });
    if (!result.envelope) return result.status!;
    try {
        const name = await send(result.envelope);
        if (!name.startsWith(`${result.envelope.spaceName}/messages/`)) throw new Error('provider identity mismatch');
        const settled = await db.chatDelivery.updateMany({ where: { id, claimToken, status: 'PROCESSING' }, data: { status: 'PROCESSED', providerMessageId: name, processedAt: new Date(), claimToken: null, processingStartedAt: null } });
        return settled.count === 1 ? 'processed' : 'lost_claim';
    } catch {
        // Never persist credential-bearing provider errors. The same identity
        // is retained for both explicit rejection and unknown network outcome.
        await db.chatDelivery.updateMany({ where: { id, claimToken, status: 'PROCESSING' }, data: { status: 'FAILED', lastError: 'Dispatch send unconfirmed; retry the same delivery identity', claimToken: null, processingStartedAt: null } });
        return 'failed';
    }
}
