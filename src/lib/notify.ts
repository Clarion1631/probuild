import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { postToChatSpace, type ChatSpace } from "@/lib/google-chat";

/**
 * Durable manager notifications for crew data that needs review/edit.
 *
 * One call fans out to up to three channels: an in-app Notification row (always), email to
 * the company's reviewers (Resend), and a Google Chat space (internal by default). It is
 * best-effort and NEVER throws into the caller — a failed notification must not fail a
 * clock-out or expense submit. Pass a `dedupeKey` to collapse repeats (e.g. one
 * open-clock-out alert per entry); a repeat is a silent no-op.
 */
export type NotifyInput = {
    type: string;
    severity?: "info" | "warning" | "urgent";
    title: string;
    body?: string;
    projectId?: string | null;
    timeEntryId?: string | null;
    expenseId?: string | null;
    actorId?: string | null;
    dedupeKey?: string | null;
    /** Explicit email recipients; defaults to company reviewers (admins + notificationEmail). */
    emailRecipients?: string[];
    /** Chat space to post to; `"internal"` default, `null` to skip Chat. */
    chatSpace?: ChatSpace | null;
};

export type NotifyResult = { id: string | null; deduped: boolean; channels: string[] };

function isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Company reviewers: the configured notificationEmail plus all active ADMIN users. */
async function resolveReviewerEmails(): Promise<string[]> {
    const emails = new Set<string>();
    try {
        const settings = await prisma.companySettings.findFirst({
            select: { notificationEmail: true },
        });
        if (settings?.notificationEmail) emails.add(settings.notificationEmail.toLowerCase());
    } catch {
        /* settings optional */
    }
    try {
        const admins = await prisma.user.findMany({
            where: { role: "ADMIN", status: { not: "DISABLED" } },
            select: { email: true },
        });
        for (const a of admins) if (a.email) emails.add(a.email.toLowerCase());
    } catch {
        /* best-effort */
    }
    return [...emails];
}

export async function notifyReview(input: NotifyInput): Promise<NotifyResult> {
    const severity = input.severity ?? "info";
    const channels: string[] = [];

    // 1. Persist the in-app record (the durable source of truth).
    let id: string;
    try {
        const row = await prisma.notification.create({
            data: {
                type: input.type,
                severity,
                title: input.title,
                body: input.body ?? null,
                projectId: input.projectId ?? null,
                timeEntryId: input.timeEntryId ?? null,
                expenseId: input.expenseId ?? null,
                actorId: input.actorId ?? null,
                dedupeKey: input.dedupeKey ?? null,
            },
            select: { id: true },
        });
        id = row.id;
        channels.push("inapp");
    } catch (e) {
        if (isUniqueViolation(e)) return { id: null, deduped: true, channels: [] };
        console.error("[notify] failed to persist notification", e);
        return { id: null, deduped: false, channels: [] };
    }

    // 2. Email reviewers (best-effort). Bounded by a timeout so a hung Resend call can never
    // stall the clock-out/expense request that triggered the notification.
    try {
        const recipients = input.emailRecipients ?? (await resolveReviewerEmails());
        if (recipients.length) {
            const subject = `[ProBuild] ${input.title}`;
            const html = `<p><strong>${input.title}</strong></p>${input.body ? `<p>${input.body}</p>` : ""}`;
            const results = await Promise.allSettled(
                recipients.map((r) =>
                    Promise.race([
                        sendNotification(r, subject, html),
                        new Promise<{ success: false }>((res) =>
                            setTimeout(() => res({ success: false }), 5000)
                        ),
                    ])
                )
            );
            // Only credit "email" when at least one send actually succeeded (sendNotification
            // resolves {success:false} on failure, so allSettled is always "fulfilled").
            const anySent = results.some(
                (r) => r.status === "fulfilled" && r.value?.success === true
            );
            if (anySent) channels.push("email");
        }
    } catch (e) {
        console.error("[notify] email fan-out failed", e);
    }

    // 3. Google Chat (internal space by default).
    const space: ChatSpace | null = input.chatSpace === undefined ? "internal" : input.chatSpace;
    if (space) {
        const tag = severity === "urgent" ? "🔴" : severity === "warning" ? "🟠" : "🔵";
        const res = await postToChatSpace(space, `${tag} *${input.title}*${input.body ? `\n${input.body}` : ""}`);
        if (res.ok) channels.push("gchat");
    }

    // Record which channels actually delivered (best-effort).
    try {
        await prisma.notification.update({ where: { id }, data: { channels: channels.join(",") } });
    } catch {
        /* non-fatal */
    }

    return { id, deduped: false, channels };
}
