import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getQBSettings } from "@/lib/integration-store";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function validSignature(rawBody: string, supplied: string, verifierToken: string) {
    const expected = Buffer.from(createHmac("sha256", verifierToken).update(rawBody).digest("base64"));
    const actual = Buffer.from(supplied);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(request: Request) {
    const verifierToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN;
    if (!verifierToken) return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
    const rawBody = await request.text();
    if (!validSignature(rawBody, request.headers.get("intuit-signature") || "", verifierToken)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let body: any;
    try { body = JSON.parse(rawBody); }
    catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

    const qb = await getQBSettings();
    const notifications = Array.isArray(body.eventNotifications) ? body.eventNotifications : [];
    const rows: Array<{ realmId: string; eventId: string; entity: string; entityQboId: string; payload: any }> = [];
    for (const notification of notifications) {
        const realmId = String(notification.realmId || "");
        if (!qb.connected || !qb.realmId || realmId !== qb.realmId) {
            return NextResponse.json({ error: "Realm mismatch" }, { status: 403 });
        }
        for (const entity of notification.dataChangeEvent?.entities || []) {
            if (!entity?.name || !entity?.id) continue;
            const fingerprint = JSON.stringify({ realmId, name: entity.name, id: entity.id, operation: entity.operation, time: entity.lastUpdated });
            rows.push({
                realmId,
                eventId: createHash("sha256").update(fingerprint).digest("hex"),
                entity: String(entity.name),
                entityQboId: String(entity.id),
                payload: { notification, entity },
            });
        }
    }

    if (rows.length) await prisma.inboundQboEvent.createMany({ data: rows, skipDuplicates: true });
    return NextResponse.json({ accepted: true, persisted: rows.length });
}
