import assert from "node:assert/strict";
import test from "node:test";
import {
    importGoogleDriveFileCore,
    MAX_GOOGLE_DRIVE_IMPORT_BYTES,
    type GoogleDriveImportDependencies,
} from "@/lib/google-drive-import-core";
import type { DriveFileMeta } from "@/lib/lead-drive";

const DRIVE_FILE_ID = "1J70gEApvZvcXsLsGmCPZTCgzslBBJpsl";
const ACTOR = { actorLabel: "justin-ai" as const, actorUserId: "user-1" };
const PDF_BYTES = Buffer.from("%PDF-1.7\nfixture");

function metadata(overrides: Partial<DriveFileMeta> = {}): DriveFileMeta {
    return {
        id: DRIVE_FILE_ID,
        name: "2220 E ST Final plan.pdf",
        mimeType: "application/pdf",
        size: PDF_BYTES.length,
        webViewLink: "https://drive.google.com/file/d/fixture-not-returned",
        ...overrides,
    };
}

function dependencies(overrides: Partial<GoogleDriveImportDependencies> = {}) {
    let metadataCalls = 0;
    let downloadCalls = 0;
    let downloadMaxBytes: number | undefined;
    let savedInput: any = null;
    const deps: GoogleDriveImportDependencies = {
        getFileMeta: async () => {
            metadataCalls++;
            return metadata();
        },
        downloadDriveFile: async (_fileId, options) => {
            downloadCalls++;
            downloadMaxBytes = options.maxBytes;
            return PDF_BYTES;
        },
        validateProjectFileTarget: async () => {},
        uploadProjectFileBufferCore: async input => {
            savedInput = input;
            return {
                ok: true as const,
                data: {
                    fileId: "project-file-1",
                    name: input.fileName,
                    sizeBytes: input.buffer.length,
                    folder: input.folder?.trim() || null,
                    visibility: input.visibility ?? "team",
                    url: "https://probuild.goldentouchremodeling.com/projects/project-1/files",
                    note: "Internal file — the customer cannot see it.",
                },
            };
        },
        ...overrides,
    };
    return {
        deps,
        state: {
            get metadataCalls() { return metadataCalls; },
            get downloadCalls() { return downloadCalls; },
            get downloadMaxBytes() { return downloadMaxBytes; },
            get savedInput() { return savedInput; },
        },
    };
}

function input(overrides: Record<string, unknown> = {}) {
    return {
        projectId: "project-1",
        driveFileId: DRIVE_FILE_ID,
        actor: ACTOR,
        ...overrides,
    };
}

test("imports an allowed Drive PDF server-side with team visibility and a ProjectFile activity", async () => {
    const { deps, state } = dependencies();

    const result = await importGoogleDriveFileCore(input(), deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, {
        fileId: "project-file-1",
        name: "2220 E ST Final plan.pdf",
        sizeBytes: PDF_BYTES.length,
        folder: null,
        visibility: "team",
        note: "Internal file — the customer cannot see it.",
    });
    assert.equal(state.metadataCalls, 1);
    assert.equal(state.downloadCalls, 1);
    assert.equal(state.downloadMaxBytes, MAX_GOOGLE_DRIVE_IMPORT_BYTES);
    assert.equal(state.savedInput.buffer, PDF_BYTES);
    assert.equal(state.savedInput.visibility, "team");
    assert.equal(state.savedInput.activityAction, "imported_google_drive_file");
    assert.deepEqual(state.savedInput.activityMetadata, {
        source: "google_drive",
        driveFileId: DRIVE_FILE_ID,
        sizeBytes: PDF_BYTES.length,
    });

    const serialized = JSON.stringify(result.data);
    assert.doesNotMatch(serialized, /https?:\/\/|token|%PDF/i, "the MCP result must not expose a Drive URL, token, or bytes");
});

test("rejects malformed Drive identifiers and URLs before Drive access", async t => {
    for (const driveFileId of ["", "https://drive.google.com/file/d/abc", "/tmp/plan.pdf", "file id with spaces", "abc!"]) {
        await t.test(JSON.stringify(driveFileId), async () => {
            const { deps, state } = dependencies();
            const result = await importGoogleDriveFileCore(input({ driveFileId }), deps);
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.error, /bare Google Drive file ID/i);
            assert.equal(state.metadataCalls, 0);
            assert.equal(state.downloadCalls, 0);
            assert.equal(state.savedInput, null);
        });
    }
});

test("rejects inaccessible and native Google Drive files without persisting", async t => {
    await t.test("inaccessible metadata", async () => {
        const { deps, state } = dependencies({
            getFileMeta: async () => { throw new Error("Google returned an opaque transport failure"); },
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /could not access/i);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });

    await t.test("native Google Doc", async () => {
        const { deps, state } = dependencies({
            getFileMeta: async () => metadata({
                name: "Scope document",
                mimeType: "application/vnd.google-apps.document",
                size: undefined,
            }),
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /Google-native files/i);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });
});

test("rejects mismatched Drive metadata, invalid metadata size, and invalid targets before download", async t => {
    await t.test("metadata belongs to a different Drive file", async () => {
        const { deps, state } = dependencies({
            getFileMeta: async () => metadata({ id: "different-drive-file-id" }),
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /different file/i);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });

    await t.test("metadata size is not a safe non-negative integer", async () => {
        const { deps, state } = dependencies({
            getFileMeta: async () => metadata({ size: -1 }),
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /invalid file size/i);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });

    await t.test("the target is validated before Drive bytes are fetched", async () => {
        let targetChecks = 0;
        const { deps, state } = dependencies({
            validateProjectFileTarget: async () => {
                targetChecks++;
                throw new Error("No project with id bogus. Use find_job or list_projects.");
            },
        });
        const result = await importGoogleDriveFileCore(input({ projectId: "bogus" }), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /No project with id bogus/i);
        assert.equal(targetChecks, 1);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });
});

test("enforces the 25 MiB cap both before and after Drive download", async t => {
    await t.test("metadata-declared size", async () => {
        const { deps, state } = dependencies({
            getFileMeta: async () => metadata({ size: MAX_GOOGLE_DRIVE_IMPORT_BYTES + 1 }),
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /25 MiB/i);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });

    await t.test("downloaded byte count", async () => {
        let downloads = 0;
        const { deps, state } = dependencies({
            downloadDriveFile: async () => {
                downloads++;
                return Buffer.alloc(MAX_GOOGLE_DRIVE_IMPORT_BYTES + 1);
            },
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /25 MiB/i);
        assert.equal(downloads, 1);
        assert.equal(state.savedInput, null);
    });
});

test("preserves the canonical ProjectFile controls for extension, shared folder, and converted lead targets", async t => {
    await t.test("disallowed extension never downloads or persists", async () => {
        const { deps, state } = dependencies({
            getFileMeta: async () => metadata({ name: "payload.exe" }),
        });
        const result = await importGoogleDriveFileCore(input(), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /not allowed/i);
        assert.equal(state.downloadCalls, 0);
        assert.equal(state.savedInput, null);
    });

    await t.test("shared-folder conflict is returned from the canonical file core", async () => {
        const { deps, state } = dependencies({
            uploadProjectFileBufferCore: async () => ({
                ok: false as const,
                error: "Folder \"Internal only\" is not a shared folder, so the customer could never see a shared file inside it.",
            }),
        });
        const result = await importGoogleDriveFileCore(input({ folder: "Internal only", visibility: "shared" }), deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /not a shared folder/i);
        assert.equal(state.downloadCalls, 1);
    });

    await t.test("a converted lead response names the project without exposing its URL", async () => {
        const { deps } = dependencies({
            uploadProjectFileBufferCore: async upload => ({
                ok: true as const,
                data: {
                    fileId: "project-file-2",
                    name: upload.fileName,
                    sizeBytes: upload.buffer.length,
                    folder: null,
                    visibility: "team",
                    url: "https://probuild.goldentouchremodeling.com/projects/project-2/files",
                    movedToProject: "This lead was already converted to project \"Converted Kitchen\" — the file was filed on the project.",
                    note: "Internal file — the customer cannot see it.",
                },
            }),
        });
        const result = await importGoogleDriveFileCore(input({ projectId: undefined, leadId: "lead-1" }), deps);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.match(result.data.movedToProject ?? "", /Converted Kitchen/);
        assert.doesNotMatch(JSON.stringify(result.data), /https?:\/\//);
    });
});
