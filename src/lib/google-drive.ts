import { google } from 'googleapis';
import { oauth2Client, loadToken } from './gmail-client';

/**
 * Service to manage Google Drive provisioning and integration for ProBuild.
 * Reuses the oauth2Client authentication configuration already established for Gmail.
 */
import { prisma } from './prisma';

/**
 * Service to manage Google Drive provisioning and integration for ProBuild.
 * Reuses the oauth2Client authentication configuration already established for Gmail.
 */
export async function createProjectDriveFolder(projectName: string, clientEmail?: string | null) {
    try {
        // Ensure token is loaded for OAuth client
        const tokenLoaded = loadToken();
        if (!tokenLoaded) {
            console.warn("[Google Drive] No token available. Google Drive actions will be mocked.");
            return getMockFolderResult(projectName);
        }

        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        // 1. Create the Master Parent Folder
        const masterFolderResponse = await drive.files.create({
            requestBody: {
                name: `${projectName} - Master Folder`,
                mimeType: 'application/vnd.google-apps.folder',
            },
            fields: 'id, webViewLink',
        });

        const masterFolderId = masterFolderResponse.data.id;
        const masterFolderLink = masterFolderResponse.data.webViewLink;

        if (!masterFolderId) {
            throw new Error("Failed to create master folder in Google Drive");
        }

        console.log(`[Google Drive] Created Master Folder: ${masterFolderId}`);

        // 2. Create subfolders inside the Master Folder
        const subfolderNames = [
            '📁 Floor Plans & Designs',
            '📁 Contracts & Approvals',
            '📁 Invoices & Payments',
            '📁 Daily Progress Photos'
        ];

        const subfolders: Record<string, { id: string; url: string }> = {};

        for (const folderName of subfolderNames) {
            const response = await drive.files.create({
                requestBody: {
                    name: folderName,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [masterFolderId],
                },
                fields: 'id, webViewLink',
            });

            if (response.data.id) {
                subfolders[folderName] = {
                    id: response.data.id,
                    url: response.data.webViewLink || '',
                };
            }
        }

        // 3. Optional: Share specific directories with the client email
        if (clientEmail) {
            try {
                // Share the Master Folder or sub-folders (with viewer access)
                await drive.permissions.create({
                    fileId: masterFolderId,
                    requestBody: {
                        role: 'reader',
                        type: 'user',
                        emailAddress: clientEmail,
                    },
                });
                console.log(`[Google Drive] Shared folder ${masterFolderId} with client ${clientEmail}`);
            } catch (shareError) {
                console.error(`[Google Drive] Failed to share folder with client:`, shareError);
            }
        }

        return {
            success: true,
            masterFolderId,
            masterFolderLink,
            subfolders,
        };

    } catch (error: any) {
        console.error("[Google Drive] Folder provisioning failed:", error);
        const mockResult = getMockFolderResult(projectName);
        return {
            success: false,
            error: error.message || "Unknown error",
            isMock: mockResult.isMock,
            masterFolderId: mockResult.masterFolderId,
            masterFolderLink: mockResult.masterFolderLink,
            subfolders: mockResult.subfolders,
        };
    }
}

/**
 * Returns mock folder structure for dev environments where Google credentials are not set up.
 */
function getMockFolderResult(projectName: string) {
    const mockId = `mock_drive_id_${Date.now()}`;
    return {
        success: true,
        isMock: true,
        masterFolderId: mockId,
        masterFolderLink: `https://drive.google.com/drive/folders/${mockId}?mock=true`,
        subfolders: {
            '📁 Floor Plans & Designs': { id: `sub_${mockId}_1`, url: '#' },
            '📁 Contracts & Approvals': { id: `sub_${mockId}_2`, url: '#' },
            '📁 Invoices & Payments': { id: `sub_${mockId}_3`, url: '#' },
            '📁 Daily Progress Photos': { id: `sub_${mockId}_4`, url: '#' }
        }
    };
}

/**
 * Lists folders and files within a given Google Drive folder for a project, with auto-healing.
 */
export async function listDriveFiles(projectId: string, folderId?: string | null) {
    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { name: true }
        });
        if (!project) {
            throw new Error("Project not found");
        }

        // Check if token is loaded
        const tokenLoaded = loadToken();
        if (!tokenLoaded) {
            console.warn("[Google Drive] No token available. Returning mock file list.");
            return getMockFiles(project.name, folderId);
        }

        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        let targetFolderId = folderId;

        // Strip "gd_" prefix if present
        if (targetFolderId && targetFolderId.startsWith("gd_")) {
            targetFolderId = targetFolderId.substring(3);
        }

        // If no folderId is provided, we need to find the Master Folder first
        if (!targetFolderId) {
            const searchQuery = `name = '${project.name} - Master Folder' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const searchResponse = await drive.files.list({
                q: searchQuery,
                fields: 'files(id, name)',
                spaces: 'drive',
            });

            const files = searchResponse.data.files;
            if (files && files.length > 0) {
                targetFolderId = files[0].id || null;
            } else {
                // Auto-provision the folder structure if not found!
                console.log(`[Google Drive] Master folder not found for ${project.name}, auto-provisioning...`);
                const provisionResult = await createProjectDriveFolder(project.name);
                if (provisionResult.success) {
                    targetFolderId = provisionResult.masterFolderId;
                } else {
                    throw new Error("Master folder not found and provisioning failed");
                }
            }
        }

        if (!targetFolderId) {
            throw new Error("Target Google Drive folder could not be resolved");
        }

        // List files/folders inside the target folder
        const response = await drive.files.list({
            q: `'${targetFolderId}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType, size, webViewLink, createdTime)',
            orderBy: 'folder, name',
        });

        const driveItems = response.data.files || [];

        const folders = driveItems
            .filter(item => item.mimeType === 'application/vnd.google-apps.folder')
            .map(item => ({
                id: `gd_${item.id}`,
                name: item.name || '',
                _count: { files: 0, children: 0 }
            }));

        const files = driveItems
            .filter(item => item.mimeType !== 'application/vnd.google-apps.folder')
            .map(item => ({
                id: `gd_${item.id}`,
                name: item.name || '',
                url: item.webViewLink || '#',
                size: parseInt(item.size || '0', 10),
                mimeType: item.mimeType || 'application/octet-stream',
                createdAt: item.createdTime || new Date().toISOString(),
            }));

        return { folders, files };

    } catch (error: any) {
        console.error("[Google Drive] Failed to list files:", error);
        try {
            const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { name: true }
            });
            return getMockFiles(project?.name || "Project", folderId);
        } catch (e) {
            return getMockFiles("Project", folderId);
        }
    }
}

/**
 * Returns mock files and subfolders for dev or error fallbacks.
 */
function getMockFiles(projectName: string, folderId?: string | null) {
    if (!folderId || folderId === 'root' || !folderId.startsWith('gd_')) {
        return {
            folders: [
                { id: 'gd_mock_floorplans', name: '📁 Floor Plans & Designs', _count: { files: 2, children: 0 } },
                { id: 'gd_mock_contracts', name: '📁 Contracts & Approvals', _count: { files: 1, children: 0 } },
                { id: 'gd_mock_invoices', name: '📁 Invoices & Payments', _count: { files: 1, children: 0 } },
                { id: 'gd_mock_photos', name: '📁 Daily Progress Photos', _count: { files: 2, children: 0 } }
            ],
            files: []
        };
    }

    const mockFilesMap: Record<string, any[]> = {
        'gd_mock_floorplans': [
            {
                id: 'gd_mock_file_fp1',
                name: 'proposed_floor_plan_v3.pdf',
                url: 'https://images.unsplash.com/photo-1504917595217-d4dc5ebe6122?auto=format&fit=crop&w=1200&q=80',
                size: 2450000,
                mimeType: 'application/pdf',
                createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
            },
            {
                id: 'gd_mock_file_fp2',
                name: 'elevation_rendering_final.jpg',
                url: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
                size: 4200000,
                mimeType: 'image/jpeg',
                createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
            }
        ],
        'gd_mock_contracts': [
            {
                id: 'gd_mock_file_c1',
                name: 'signed_construction_agreement_fully_executed.pdf',
                url: 'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=1200&q=80',
                size: 1850000,
                mimeType: 'application/pdf',
                createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
            }
        ],
        'gd_mock_invoices': [
            {
                id: 'gd_mock_file_i1',
                name: 'deposit_invoice_paid_INV-4029.pdf',
                url: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=1200&q=80',
                size: 920000,
                mimeType: 'application/pdf',
                createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()
            }
        ],
        'gd_mock_photos': [
            {
                id: 'gd_mock_file_p1',
                name: 'framing_milestone_completed.jpg',
                url: 'https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=1200&q=80',
                size: 3800000,
                mimeType: 'image/jpeg',
                createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
            },
            {
                id: 'gd_mock_file_p2',
                name: 'drywall_hanging_in_progress.jpg',
                url: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=1200&q=80',
                size: 3100000,
                mimeType: 'image/jpeg',
                createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
            }
        ]
    };

    const files = mockFilesMap[folderId] || mockFilesMap['gd_mock_photos'] || [];

    return {
        folders: [],
        files
    };
}

/**
 * A BOUNDED metadata read for one Drive file, for verification rather than
 * display.
 *
 * NO MOCK FALLBACK, deliberately, and that is the whole point of it being
 * separate from the functions above. They degrade to mock data when no token is
 * loaded, which is right for a UI that would otherwise be empty in development
 * — and catastrophic here: "we could not ask Google" would come back as "the
 * file is there", and a signed-memo resolution would be recorded against an
 * artifact nobody ever confirmed exists. Unknown is its own answer.
 */
export type DriveFileProbe =
    | { kind: "found"; id: string; name: string | null; trashed: boolean; webViewLink: string | null }
    /** Google answered, and there is no such file (or it is in the bin). */
    | { kind: "missing"; reason: string }
    /** We could not ask, or could not understand the answer. NOT a verdict. */
    | { kind: "unreachable"; reason: string };

/** Drive ids are long, opaque and URL-safe. Anything else is a paste error. */
export function isDriveFileId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(value.trim());
}

export async function probeDriveFile(fileId: string, timeoutMs = 5_000): Promise<DriveFileProbe> {
    if (!isDriveFileId(fileId)) return { kind: "missing", reason: "invalid-id" };
    if (!loadToken()) return { kind: "unreachable", reason: "no-drive-token" };
    try {
        const drive = google.drive({ version: "v3", auth: oauth2Client });
        const response = await drive.files.get(
            { fileId: fileId.trim(), fields: "id, name, trashed, webViewLink", supportsAllDrives: true },
            { timeout: timeoutMs },
        );
        const data = response.data;
        if (!data?.id) return { kind: "unreachable", reason: "no-body" };
        // A file in the bin is not a durable artifact: it disappears on its own.
        if (data.trashed) return { kind: "missing", reason: "trashed" };
        return {
            kind: "found",
            id: data.id,
            name: data.name ?? null,
            trashed: false,
            webViewLink: data.webViewLink ?? null,
        };
    } catch (error) {
        const status = (error as { code?: number; status?: number })?.code
            ?? (error as { status?: number })?.status;
        // 404/410 are ANSWERS — that file is not there. Everything else
        // (timeout, 5xx, auth, network) is us being unable to ask.
        if (status === 404 || status === 410) return { kind: "missing", reason: `http-${status}` };
        return {
            kind: "unreachable",
            reason: error instanceof Error ? error.message.slice(0, 120) : "unknown-error",
        };
    }
}
