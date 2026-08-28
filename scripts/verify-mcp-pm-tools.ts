// Behavioral verification for SPEC-mcp-pm-phase1.
//
// This verifier never applies schema and never runs either seed/backfill script.
// Release orchestration must apply scripts/apply-mcp-pm-schema.mjs first.
//
// Usage against Supabase:
//   $env:ALLOW_PROD_VERIFY="1"
//   npx tsx --env-file=.env.local scripts/verify-mcp-pm-tools.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { prisma } from "../src/lib/prisma";

const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const FIXTURE_PREFIX = `MCP PM VERIFY ${RUN_ID}`;

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

function loadDatabaseUrl(): string {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env.local", ".env"]) {
        if (!existsSync(file)) continue;
        const match = readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
        if (match) {
            process.env.DATABASE_URL = match[1];
            return match[1];
        }
    }
    return "";
}

async function rejectsWith(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
    let message = "";
    try {
        await run();
    } catch (error) {
        message = String((error as Error)?.message ?? error);
    }
    assert.match(message, pattern);
}

function confirmationToken(result: any): string {
    assert.equal(result.confirmationRequired, true);
    assert.equal(typeof result.preview, "string");
    assert.ok(result.preview.length > 0);
    assert.match(result.confirmToken, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    return result.confirmToken;
}

function assertNoForbiddenContactKeys(value: unknown, path = "contacts"): void {
    if (Array.isArray(value)) {
        value.forEach((child, index) => assertNoForbiddenContactKeys(child, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        assert.ok(
            ![
                "hourlyrate",
                "burdenrate",
                "rate",
                "cost",
                "amount",
                "budget",
                "addressline1",
                "addressline2",
                "city",
                "state",
                "zipcode",
                "country",
                "licenseNumber",
            ].map(item => item.toLowerCase()).includes(normalized),
            `${path}.${key} crosses the MCP contact PII boundary`,
        );
        assertNoForbiddenContactKeys(child, `${path}.${key}`);
    }
}

async function main() {
    const expectedFiles = [
        "../src/lib/mcp-actor.ts",
        "../src/lib/project-folders.ts",
        "../src/lib/project-file-core.ts",
        "../src/lib/google-drive-import-core.ts",
        "../src/lib/daily-log-core.ts",
        "../src/lib/mcp-pm-tools.ts",
        "./seed-richard-ai-user.mjs",
        "./backfill-standard-folders.ts",
        "./apply-mcp-pm-schema.mjs",
    ];
    for (const path of expectedFiles) {
        assert.ok(existsSync(new URL(path, import.meta.url)), `${path} must exist`);
    }

    const routeSource = source("../src/app/api/mcp/[transport]/route.ts");
    const schemaSource = source("../prisma/schema.prisma");
    const actorSource = source("../src/lib/mcp-actor.ts");
    const folderSource = source("../src/lib/project-folders.ts");
    const fileCoreSource = source("../src/lib/project-file-core.ts");
    const driveImportSource = source("../src/lib/google-drive-import-core.ts");
    const leadDriveSource = source("../src/lib/lead-drive.ts");
    const pmCoreSource = source("../src/lib/mcp-pm-tools.ts");
    const dailyCoreSource = source("../src/lib/daily-log-core.ts");
    const actionSource = source("../src/lib/actions.ts");
    const confirmationSource = source("../src/lib/mcp-schedule-tools.ts");
    const applySource = source("./apply-mcp-pm-schema.mjs");
    const seedSource = source("./seed-richard-ai-user.mjs");
    const backfillSource = source("./backfill-standard-folders.ts");

    // Static registry, security, migration, and no-Phase-2 contracts.
    assert.match(routeSource, /MCP_SECRET_RICHARD/);
    assert.match(routeSource, /timingSafeEqual/);
    assert.match(routeSource, /serverInfo:\s*\{\s*name:\s*"probuild",\s*version:\s*"1\.16\.0"\s*\}/);
    for (const toolName of [
        "upload_file",
        "upload_files",
        "import_google_drive_file",
        "list_project_files",
        "create_folder",
        "move_file",
        "list_daily_logs",
        "create_daily_log",
        "list_punch_items",
        "add_punch_items",
        "get_project_contacts",
        "read_file",
        "get_file_link",
    ]) {
        assert.match(routeSource, new RegExp(`"${toolName}"`), `${toolName} must be registered`);
    }
    assert.doesNotMatch(routeSource, /registerTool\(\s*"complete_punch_item"/);
    assert.match(routeSource, /complete_punch_item[\s\S]{0,300}(?:cut|absent|not registered|human reported)/i);
    assert.match(routeSource, /Project management/i);
    // File download through MCP was deliberately enabled (read_file for text,
    // get_file_link for a link), reversing the earlier "no download" contract.
    // Reads must never dereference a stored URL — downloadDocBytes only.
    assert.doesNotMatch(routeSource, /download is not available/i);
    assert.match(routeSource, /downloadDocBytes/);
    assert.match(routeSource, /resolveDocUrl/);
    assert.match(schemaSource, /model McpConfirmation \{[\s\S]*\bactorLabel\s+String/);
    assert.match(schemaSource, /model TaskPunchItem \{[\s\S]*\bcreatedById\s+String\?/);
    assert.match(applySource, /ADD COLUMN IF NOT EXISTS "actorLabel"/);
    assert.match(applySource, /ADD COLUMN IF NOT EXISTS "createdById"/);
    assert.match(seedSource, /richard-ai@goldentouchremodeling\.com/);
    assert.match(seedSource, /Richard's AI/);
    // The attribution row must be a DISABLED service identity, never a live login.
    // auth.ts admits any existing user that is not DISABLED, so an ACTIVATED row is
    // a staff session waiting for someone to create the matching Google identity.
    assert.match(seedSource, /status:\s*"DISABLED"/);
    assert.doesNotMatch(seedSource, /status:\s*"ACTIVATED"/);
    assert.doesNotMatch(seedSource, /FIELD_CREW/);
    assert.match(backfillSource, /--write/);
    assert.match(backfillSource, /dry.run/i);
    assert.match(folderSource, /mode:\s*"insensitive"|toLocaleLowerCase|toLowerCase/);
    assert.match(fileCoreSource, /MAX_UPLOAD_BYTES\s*=\s*3_300_000/);
    assert.match(fileCoreSource, /visibility\s*\?\?\s*"team"/);
    assert.match(fileCoreSource, /uploadProjectFileBufferCore/);
    assert.match(routeSource, /WRITE_TOOLS[\s\S]{0,600}"import_google_drive_file"/);
    assert.match(routeSource, /ENTITY_TYPE_BY_TOOL[\s\S]{0,1200}import_google_drive_file:\s*"file"/);
    assert.match(routeSource, /import_google_drive_file[\s\S]{0,1800}bare Drive file ID/);
    assert.match(driveImportSource, /MAX_GOOGLE_DRIVE_IMPORT_BYTES\s*=\s*25\s*\*\s*1024\s*\*\s*1024/);
    assert.match(driveImportSource, /application\/vnd\.google-apps\./);
    assert.match(driveImportSource, /uploadProjectFileBufferCore/);
    assert.match(driveImportSource, /validateProjectFileTarget/);
    assert.match(driveImportSource, /maxBytes:\s*MAX_GOOGLE_DRIVE_IMPORT_BYTES/);
    assert.match(driveImportSource, /const \{ url: _url, \.\.\.safeData \}/);
    assert.doesNotMatch(driveImportSource, /webViewLink[\s\S]{0,250}data:/);
    assert.match(leadDriveSource, /responseType:\s*"stream"/);
    assert.match(leadDriveSource, /DriveFileTooLargeError/);
    assert.match(dailyCoreSource, /createdById:\s*actorUserId/);
    assert.match(actionSource, /createDailyLogCore/);
    // Customer-facing sends are "use server" exports, i.e. remotely invokable
    // endpoints. Contract send previously had NO authorization at all. Both sends
    // must gate on the shared helper, and the audit actor must be DERIVED from
    // whatever authenticated the call — never accepted as a parameter, or a caller
    // can authenticate as itself and log the action as somebody else.
    assert.match(actionSource, /assertContractSendPermission/);
    assert.match(actionSource, /const sendActor = await assertContractSendPermission\(mcpSecret\)/);
    assert.match(actionSource, /const sendActor = await assertEstimateSendPermission\(mcpSecret\)/);
    assert.doesNotMatch(actionSource, /mcpActorLabel/);
    assert.match(actionSource, /actorName: sendActor\.name/);
    // Permission says WHAT, not WHICH: both sends must scope the caller to the
    // loaded document, or a non-admin holding contracts/estimates could send a
    // document from a job they cannot access just by knowing its id.
    assert.match(actionSource, /assertSendScope\(sendActor, \{ projectId: contract\.projectId/);
    assert.match(actionSource, /assertSendScope\(sendActor, \{ projectId: estimate\.project\?\.id/);
    // ONLY undefined is omission. Excluding null too let an explicit null skip
    // validation and reach the staff-session path — the very fallback being closed.
    assert.match(actionSource, /if \(mcpSecret !== undefined\) \{/);
    assert.doesNotMatch(actionSource, /mcpSecret !== undefined && mcpSecret !== null/);
    // An ownerless document must fail CLOSED, and before the machine exemption:
    // both ownership columns are optional and such a doc can still be emailed.
    assert.match(actionSource, /if \(!scope\.projectId && !scope\.leadId\) \{[\s\S]{0,200}throw new Error/);
    // The raw audit writer must NOT live on the "use server" surface, or callers
    // can forge history (e.g. a sent_contract attributed to anyone).
    assert.doesNotMatch(actionSource, /export async function logActivity/);
    assert.ok(existsSync(new URL("../src/lib/activity-log.ts", import.meta.url)), "activity-log.ts must exist");
    // The DIRECTIVE, not the phrase — the file's header comment explains why it is
    // deliberately not a "use server" module.
    assert.doesNotMatch(source("../src/lib/activity-log.ts"), /^\s*["']use server["']/m);
    assert.match(confirmationSource, /actorLabel/);
    assert.match(confirmationSource, /consumedAt:\s*null/);
    assert.match(confirmationSource, /expiresAt:\s*\{\s*gt:/);
    assert.match(pmCoreSource, /SYSTEM:/);
    console.log("PASS static auth, schema, registry, no-download, and no-punch-completion contracts");

    const [
        actorModule,
        folderModule,
        fileModule,
        pmModule,
        routeModule,
    ]: any[] = await Promise.all([
        import("../src/lib/mcp-actor"),
        import("../src/lib/project-folders"),
        import("../src/lib/project-file-core"),
        import("../src/lib/mcp-pm-tools"),
        import("../src/app/api/mcp/[transport]/route"),
    ]);

    // Auth is tested without touching the DB. Both comparisons execute in the
    // same helper, unset/empty values never authenticate, and the label is exact.
    const originalJustin = process.env.MCP_SECRET;
    const originalRichard = process.env.MCP_SECRET_RICHARD;
    try {
        process.env.MCP_SECRET = `justin-${RUN_ID}`;
        process.env.MCP_SECRET_RICHARD = `richard-${RUN_ID}`;
        const request = (key: string) => new Request(`https://example.invalid/api/mcp/mcp?key=${encodeURIComponent(key)}`);
        assert.equal(routeModule.resolveMcpActorLabel(request(process.env.MCP_SECRET)), "justin-ai");
        assert.equal(routeModule.resolveMcpActorLabel(request(process.env.MCP_SECRET_RICHARD)), "richard-ai");
        assert.equal(routeModule.resolveMcpActorLabel(request(`wrong-${RUN_ID}`)), null);
        process.env.MCP_SECRET_RICHARD = "";
        assert.equal(routeModule.resolveMcpActorLabel(request("")), null);
    } finally {
        if (originalJustin === undefined) delete process.env.MCP_SECRET;
        else process.env.MCP_SECRET = originalJustin;
        if (originalRichard === undefined) delete process.env.MCP_SECRET_RICHARD;
        else process.env.MCP_SECRET_RICHARD = originalRichard;
    }
    console.log("PASS dual-key auth labels, wrong key, and empty-key refusal");

    // The static + auth contracts above are DB-free and must run everywhere.
    // Only the behavioral matrix below creates/deletes fixtures, so the prod
    // guard fences exactly that — not the whole script (it originally sat at
    // the top of main(), which silently skipped every static check on any
    // machine whose DATABASE_URL points at Supabase).
    const databaseUrl = loadDatabaseUrl();
    if (databaseUrl.includes("supabase.c") && process.env.ALLOW_PROD_VERIFY !== "1") {
        console.log(
            "[verify-mcp-pm-tools] static + auth contracts PASS; skipping the DB-backed behavioral matrix\n" +
            "  (DATABASE_URL points at Supabase and this phase creates/deletes fixtures — run against a\n" +
            "  disposable database, or set ALLOW_PROD_VERIFY=1 to opt in).",
        );
        return;
    }

    const confirmationDelegate = (prisma as any).mcpConfirmation;
    await confirmationDelegate.findFirst({ select: { id: true, actorLabel: true } });
    await (prisma as any).taskPunchItem.findFirst({ select: { id: true, createdById: true } });

    const collected = {
        clientIds: [] as string[],
        projectIds: [] as string[],
        userIds: [] as string[],
        subcontractorIds: [] as string[],
        confirmationTokens: [] as string[],
    };
    let cleanupPassed = false;

    try {
        const client = await prisma.client.create({
            data: {
                name: `${FIXTURE_PREFIX} CLIENT DELETE ME`,
                initials: "MP",
                email: `mcp-pm-client-${RUN_ID}@example.invalid`,
                primaryPhone: "555-0101",
                addressLine1: "PII boundary sentinel",
            },
        });
        collected.clientIds.push(client.id);
        const actorUser = await prisma.user.create({
            data: {
                email: `mcp-pm-actor-${RUN_ID}@example.invalid`,
                name: "MCP PM Actor",
                role: "FINANCE",
                status: "ACTIVATED",
            },
        });
        const crewUser = await prisma.user.create({
            data: {
                email: `mcp-pm-crew-${RUN_ID}@example.invalid`,
                name: "MCP Crew",
                role: "FIELD_CREW",
                status: "ACTIVATED",
                hourlyRate: 999,
                burdenRate: 999,
            },
        });
        collected.userIds.push(actorUser.id, crewUser.id);
        const project = await prisma.project.create({
            data: {
                name: `${FIXTURE_PREFIX} PROJECT DELETE ME`,
                clientId: client.id,
                status: "In Progress",
                location: "Project location is allowed",
                managerId: actorUser.id,
                crew: { connect: { id: crewUser.id } },
            },
        });
        const secondProject = await prisma.project.create({
            data: {
                name: `${FIXTURE_PREFIX} SECOND PROJECT DELETE ME`,
                clientId: client.id,
                status: "In Progress",
            },
        });
        collected.projectIds.push(project.id, secondProject.id);
        const justinActor = { actorLabel: "justin-ai", actorUserId: actorUser.id };
        const richardActor = { actorLabel: "richard-ai", actorUserId: actorUser.id };

        // Confirmation tokens are actor-bound and cannot cross connector keys.
        const folderArgs = { projectId: project.id, name: "Cross-key probe", visibility: "team" };
        const folderPreview = await pmModule.createFolderWithConfirmation(folderArgs, justinActor);
        const folderToken = confirmationToken(folderPreview);
        collected.confirmationTokens.push(folderToken);
        await rejectsWith(
            () => pmModule.createFolderWithConfirmation({ ...folderArgs, confirmToken: folderToken }, richardActor),
            /actor|key|confirmation/i,
        );
        assert.equal(await prisma.fileFolder.count({ where: { projectId: project.id, name: folderArgs.name } }), 0);
        console.log("PASS cross-key confirmation refusal");

        // Standard folders create once and dedupe case-insensitively.
        await prisma.fileFolder.create({
            data: { projectId: project.id, name: "01 plans & specs", visibility: "team" },
        });
        const firstEnsure = await folderModule.ensureStandardFolders(project.id);
        assert.equal(firstEnsure.created.length, 7);
        const secondEnsure = await folderModule.ensureStandardFolders(project.id);
        assert.equal(secondEnsure.created.length, 0);
        assert.equal(
            await prisma.fileFolder.count({ where: { projectId: project.id, parentId: null } }),
            folderModule.STANDARD_PROJECT_FOLDERS.length,
        );
        console.log("PASS standard-folder scaffold idempotency and case-insensitive dedup");

        const saveWithoutStorage = async (input: any) => {
            if (input.fileName === "storage-fails.pdf") {
                return { ok: false as const, error: "Synthetic storage failure" };
            }
            const file = await prisma.projectFile.create({
                data: {
                    name: input.fileName,
                    url: `https://example.invalid/${RUN_ID}/${input.fileName}`,
                    size: input.buffer.length,
                    mimeType: input.mimeType,
                    visibility: input.visibility,
                    projectId: input.projectId,
                    leadId: input.leadId,
                    folderId: input.folderId,
                    uploadedById: input.uploadedById,
                },
                select: { id: true, name: true, size: true, url: true },
            });
            return { ok: true as const, file };
        };

        // The single-file core owns every portal-safety invariant.
        const teamUpload = await fileModule.uploadProjectFileCore({
            projectId: project.id,
            fileName: "internal.pdf",
            contentBase64: Buffer.from("internal").toString("base64"),
            actor: richardActor,
        }, { saveProjectFile: saveWithoutStorage });
        assert.equal(teamUpload.ok, true);
        const teamFile = await prisma.projectFile.findUniqueOrThrow({ where: { id: teamUpload.data.fileId } });
        assert.equal(teamFile.visibility, "team");
        assert.equal(teamFile.uploadedById, actorUser.id);

        const teamFolder = await prisma.fileFolder.create({
            data: { projectId: project.id, name: "Internal only", visibility: "team" },
        });
        const refusedShared = await fileModule.uploadProjectFileCore({
            projectId: project.id,
            fileName: "shared.pdf",
            contentBase64: Buffer.from("shared").toString("base64"),
            folder: teamFolder.name,
            visibility: "shared",
            actor: richardActor,
        }, { saveProjectFile: saveWithoutStorage });
        assert.equal(refusedShared.ok, false);
        assert.match(refusedShared.error, /not a shared folder/i);

        const sharedUpload = await fileModule.uploadProjectFileCore({
            projectId: project.id,
            fileName: "shared-photo.jpg",
            contentBase64: Buffer.from("image").toString("base64"),
            folder: "Customer photos",
            visibility: "shared",
            actor: richardActor,
        }, { saveProjectFile: saveWithoutStorage });
        assert.equal(sharedUpload.ok, true);
        assert.equal(
            (await prisma.fileFolder.findFirstOrThrow({
                where: { projectId: project.id, name: "Customer photos" },
            })).visibility,
            "shared",
        );
        console.log("PASS upload core explicit visibility, team-folder refusal, and shared-folder creation");

        const oversized = Buffer.alloc(fileModule.MAX_UPLOAD_BYTES + 1, 1).toString("base64");
        assert.throws(
            () => fileModule.validateUploadFilesBatch([
                { fileName: "one.pdf", contentBase64: oversized },
            ]),
            /~3 MB|3 MB|total/i,
        );
        let invalidWriteCalls = 0;
        const invalidBatch = await fileModule.uploadProjectFilesCore({
            projectId: project.id,
            files: [
                { fileName: "valid.pdf", contentBase64: Buffer.from("valid").toString("base64") },
                { fileName: "invalid.exe", contentBase64: Buffer.from("invalid").toString("base64") },
            ],
            actor: richardActor,
        }, {
            saveProjectFile: async () => {
                invalidWriteCalls++;
                return { ok: false as const, error: "must not run" };
            },
        });
        assert.equal(invalidBatch.ok, false);
        assert.equal(invalidWriteCalls, 0);

        const conflictingBatch = await fileModule.uploadProjectFilesCore({
            projectId: project.id,
            files: [
                {
                    fileName: "new-shared.pdf",
                    contentBase64: Buffer.from("new shared").toString("base64"),
                    folder: "Must not be created",
                    visibility: "shared",
                },
                {
                    fileName: "conflicting-shared.pdf",
                    contentBase64: Buffer.from("conflict").toString("base64"),
                    folder: teamFolder.name,
                    visibility: "shared",
                },
            ],
            actor: richardActor,
        }, { saveProjectFile: saveWithoutStorage });
        assert.equal(conflictingBatch.ok, false);
        assert.equal(
            await prisma.fileFolder.count({
                where: { projectId: project.id, name: "Must not be created" },
            }),
            0,
        );

        const partialBatch = await fileModule.uploadProjectFilesCore({
            projectId: project.id,
            files: [
                { fileName: "batch-ok.pdf", contentBase64: Buffer.from("ok").toString("base64") },
                { fileName: "storage-fails.pdf", contentBase64: Buffer.from("fail").toString("base64") },
            ],
            actor: richardActor,
        }, { saveProjectFile: saveWithoutStorage });
        assert.equal(partialBatch.ok, true);
        assert.deepEqual(
            partialBatch.results.map((row: any) => ({ fileName: row.fileName, ok: row.ok, hasFileId: !!row.fileId, error: row.error })),
            [
                { fileName: "batch-ok.pdf", ok: true, hasFileId: true, error: undefined },
                { fileName: "storage-fails.pdf", ok: false, hasFileId: false, error: "Synthetic storage failure" },
            ],
        );
        console.log("PASS multi-upload total cap, whole-batch validation, and partial storage-result shape");

        // Moving cannot cross owners or accidentally expose team content.
        const sharedTarget = await prisma.fileFolder.create({
            data: { projectId: project.id, name: "Shared target", visibility: "shared" },
        });
        const otherTarget = await prisma.fileFolder.create({
            data: { projectId: secondProject.id, name: "Other project", visibility: "team" },
        });
        await rejectsWith(
            () => pmModule.moveFileWithConfirmation({
                fileId: teamFile.id,
                folderId: otherTarget.id,
            }, richardActor),
            /same project|cross-project|different project/i,
        );
        await rejectsWith(
            () => pmModule.moveFileWithConfirmation({
                fileId: teamFile.id,
                folderId: sharedTarget.id,
            }, richardActor),
            /visibility.*shared|expose|customer/i,
        );
        const moveArgs = { fileId: teamFile.id, folderId: sharedTarget.id, visibility: "shared" as const };
        const movePreview = await pmModule.moveFileWithConfirmation(moveArgs, richardActor);
        const moveToken = confirmationToken(movePreview);
        collected.confirmationTokens.push(moveToken);
        await pmModule.moveFileWithConfirmation({ ...moveArgs, confirmToken: moveToken }, richardActor);
        const moved = await prisma.projectFile.findUniqueOrThrow({ where: { id: teamFile.id } });
        assert.equal(moved.folderId, sharedTarget.id);
        assert.equal(moved.visibility, "shared");
        console.log("PASS move_file cross-owner and visibility-refusal matrix");

        // Daily logs bind the explicit actor FK and copy same-project file URLs.
        const photo = await prisma.projectFile.create({
            data: {
                projectId: project.id,
                name: "daily-photo.jpg",
                url: `https://example.invalid/${RUN_ID}/daily-photo.jpg`,
                size: 5,
                mimeType: "image/jpeg",
                visibility: "team",
            },
        });
        const logArgs = {
            projectId: project.id,
            date: "2048-05-04",
            weather: "Clear",
            crewOnSite: "MCP Crew",
            workPerformed: "Completed the verifier work.",
            materialsDelivered: "Verification fixtures",
            issues: "None",
            photos: [{ fileId: photo.id, caption: "Verifier photo" }],
        };
        const logPreview = await pmModule.createDailyLogWithConfirmation(logArgs, richardActor);
        const logToken = confirmationToken(logPreview);
        collected.confirmationTokens.push(logToken);
        const logResult = await pmModule.createDailyLogWithConfirmation({ ...logArgs, confirmToken: logToken }, richardActor);
        const log = await prisma.dailyLog.findUniqueOrThrow({
            where: { id: logResult.dailyLogId },
            include: { photos: true },
        });
        assert.equal(log.createdById, actorUser.id);
        assert.equal(log.sharedToPortal, false);
        assert.equal(log.photos[0]?.url, photo.url);
        console.log("PASS daily-log actor provenance, no portal-sharing input, and ProjectFile photo attachment");

        // Punch additions preserve contiguous ordering and creator provenance.
        const task = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Punch verifier task",
                startDate: new Date("2048-05-04T00:00:00.000Z"),
                endDate: new Date("2048-05-05T00:00:00.000Z"),
            },
        });
        const punchArgs = { taskId: task.id, items: ["First punch", "Second punch"] };
        const punchPreview = await pmModule.addPunchItemsWithConfirmation(punchArgs, richardActor);
        const punchToken = confirmationToken(punchPreview);
        collected.confirmationTokens.push(punchToken);
        await pmModule.addPunchItemsWithConfirmation({ ...punchArgs, confirmToken: punchToken }, richardActor);
        const punchItems = await prisma.taskPunchItem.findMany({ where: { taskId: task.id }, orderBy: { order: "asc" } });
        assert.deepEqual(punchItems.map(item => item.order), [0, 1]);
        assert.ok(punchItems.every((item: any) => item.createdById === actorUser.id));
        const listedPunch = await pmModule.listPunchItems({ taskId: task.id, status: "open" });
        assert.equal(listedPunch.items.length, 2);
        assert.ok(listedPunch.items.every((item: any) => item.completed === false && item.completedAt === null));
        console.log("PASS punch bulk ordering, creator provenance, and read surface");

        const subcontractor = await prisma.subcontractor.create({
            data: {
                companyName: `${FIXTURE_PREFIX} SUB DELETE ME`,
                contactName: "Sub Contact",
                email: `mcp-pm-sub-${RUN_ID}@example.invalid`,
                phone: "555-0102",
                trade: "Electrical",
                licenseNumber: "PII-BOUNDARY-SENTINEL",
            },
        });
        collected.subcontractorIds.push(subcontractor.id);
        await prisma.subTaskAssignment.create({
            data: { taskId: task.id, subcontractorId: subcontractor.id },
        });
        const contacts = await pmModule.getProjectContacts({ projectId: project.id });
        assertNoForbiddenContactKeys(contacts);
        assert.equal(contacts.project.location, project.location);
        assert.equal(contacts.client.email, client.email);
        assert.ok(contacts.crew.some((member: any) => member.name === crewUser.name));
        assert.ok(contacts.subcontractors.some((sub: any) => sub.company === subcontractor.companyName));
        console.log("PASS project-contact shape and PII boundary");
    } finally {
        try {
            if (collected.confirmationTokens.length > 0) {
                await confirmationDelegate.deleteMany({
                    where: { token: { in: collected.confirmationTokens } },
                });
            }
            if (collected.projectIds.length > 0) {
                await prisma.project.deleteMany({ where: { id: { in: collected.projectIds } } });
            }
            if (collected.subcontractorIds.length > 0) {
                await prisma.subcontractor.deleteMany({ where: { id: { in: collected.subcontractorIds } } });
            }
            if (collected.userIds.length > 0) {
                await prisma.user.deleteMany({ where: { id: { in: collected.userIds } } });
            }
            if (collected.clientIds.length > 0) {
                await prisma.client.deleteMany({ where: { id: { in: collected.clientIds } } });
            }
            const [confirmationsLeft, clientsLeft, projectsLeft, usersLeft, subcontractorsLeft] = await Promise.all([
                confirmationDelegate.count({ where: { token: { in: collected.confirmationTokens } } }),
                prisma.client.count({ where: { id: { in: collected.clientIds } } }),
                prisma.project.count({ where: { id: { in: collected.projectIds } } }),
                prisma.user.count({ where: { id: { in: collected.userIds } } }),
                prisma.subcontractor.count({ where: { id: { in: collected.subcontractorIds } } }),
            ]);
            cleanupPassed = confirmationsLeft === 0
                && clientsLeft === 0
                && projectsLeft === 0
                && usersLeft === 0
                && subcontractorsLeft === 0;
        } catch (error) {
            console.error("Fixture cleanup error:", error);
        }
        console.log(`${cleanupPassed ? "PASS" : "FAIL"} fixture cleanup`);
    }

    assert.equal(cleanupPassed, true);
    console.log("mcp-pm-tools verification: PASS");
}

main()
    .catch(error => {
        console.error("mcp-pm-tools verification: FAIL");
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await prisma.$disconnect();
        } catch {
            // Static RED and missing-schema failures can happen before Prisma connects.
        }
    });
