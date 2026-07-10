import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { parseOfficeTaskDateOnly } from "@/lib/office-task-utils";

export const dynamic = "force-dynamic";

/**
 * Office Tasks ingest — lets the owner's Google Chat AI routines auto-file
 * "needs a human" items onto the /tasks board, each carrying a ready-to-run
 * AI prompt and a diagnosis of what capability gap forced the handoff.
 *
 * Auth: Authorization: Bearer ${OFFICE_TASKS_INGEST_SECRET}. Secret-authed,
 * not session-authed — does NOT call assertOfficeTaskAccess (there is no
 * human session here).
 */

const MAX_TITLE_LENGTH = 300;

interface IngestPayload {
    title?: string;
    notes?: string;
    aiPrompt?: string;
    automationGap?: string;
    source?: string;
    assigneeEmail?: string;
    dueDate?: string; // "YYYY-MM-DD"
    column?: string; // board column name, case-insensitive; falls back to the first column
    status?: string; // legacy alias for `column`
}

export async function POST(req: Request) {
    const secret = process.env.OFFICE_TASKS_INGEST_SECRET;
    if (!secret) {
        console.error("OFFICE_TASKS_INGEST_SECRET is not configured");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: IngestPayload;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const title = (body.title || "").trim();
    if (!title) {
        return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (title.length > MAX_TITLE_LENGTH) {
        return NextResponse.json({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` }, { status: 400 });
    }

    let dueDate: Date | null = null;
    if (body.dueDate) {
        try {
            dueDate = parseOfficeTaskDateOnly(body.dueDate);
        } catch {
            return NextResponse.json({ error: "dueDate must be a YYYY-MM-DD string" }, { status: 400 });
        }
    }

    // Dedupe: an already-filed, not-archived task with the same title (case-
    // insensitive) that isn't sitting in a "Done"-style column means this is a
    // re-send of something already on the board.
    const existing = await prisma.officeTask.findFirst({
        where: {
            title: { equals: title, mode: "insensitive" },
            archivedAt: null,
            OR: [{ columnId: null }, { column: { isDoneColumn: false } }],
        },
        select: { id: true },
    });
    if (existing) {
        return NextResponse.json({ deduped: true, id: existing.id }, { status: 200 });
    }

    // Resolve the target column by name (case-insensitive), falling back to the
    // first-position column when unspecified or unmatched.
    const columnNameInput = (body.column || body.status || "").trim();
    let column = columnNameInput
        ? await prisma.officeBoardColumn.findFirst({
            where: { name: { equals: columnNameInput, mode: "insensitive" } },
        })
        : null;
    if (!column) {
        column = await prisma.officeBoardColumn.findFirst({ orderBy: { position: "asc" } });
    }
    if (!column) {
        console.error("No OfficeBoardColumn configured — cannot ingest task");
        return NextResponse.json({ error: "No board column configured" }, { status: 500 });
    }
    const targetColumn = column;

    let assigneeId: string | null = null;
    if (body.assigneeEmail?.trim()) {
        const assignee = await prisma.user.findFirst({
            where: {
                email: { equals: body.assigneeEmail.trim(), mode: "insensitive" },
                role: { in: ["ADMIN", "MANAGER"] },
                status: "ACTIVATED",
            },
            select: { id: true },
        });
        assigneeId = assignee?.id ?? null; // no match → create unassigned, never error
    }

    let notes = body.notes?.trim() || null;
    if (body.source?.trim()) {
        const sourceLine = `Source: ${body.source.trim()}`;
        notes = notes ? `${notes}\n${sourceLine}` : sourceLine;
    }

    const task = await prisma.$transaction(async (tx) => {
        const last = await tx.officeTask.findFirst({
            where: { columnId: targetColumn.id, archivedAt: null },
            orderBy: { position: "desc" },
            select: { position: true },
        });

        return tx.officeTask.create({
            data: {
                title,
                columnId: targetColumn.id,
                status: targetColumn.name, // TRANSITIONAL COMPAT — see OfficeTask.status
                position: (last?.position ?? -1) + 1,
                notes,
                aiPrompt: body.aiPrompt?.trim() || null,
                automationGap: body.automationGap?.trim() || null,
                assigneeId,
                dueDate,
                createdById: null,
            },
            select: { id: true },
        });
    });

    revalidatePath("/tasks");
    return NextResponse.json({ id: task.id }, { status: 201 });
}
