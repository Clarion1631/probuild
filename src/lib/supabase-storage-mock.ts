// In-memory Supabase Storage stand-in for e2e runs (E2E_STORAGE_MOCK=1) —
// see the production guard in supabase.ts's getSupabase(), which mirrors the
// SELECTION_AI_MOCK gate (flag && !process.env.VERCEL, so it can never engage
// on a real deploy). CI's Playwright job runs against a throwaway Postgres
// with no Supabase credentials at all; this stub makes the storage-dependent
// paths (comment attachments, signed-PDF filing, signature persistence) work
// hermetically instead of either failing or writing junk objects into the
// live production bucket.
//
// Only the `storage` surface is implemented — Supabase is storage-only on the
// server (data access is Prisma, auth is NextAuth), so nothing else should be
// reached in a test run. Objects live in a Map cached on globalThis so state
// survives Next.js instantiating this module once per route bundle.
//
// KNOWN LIMITATION: the URLs this mock returns (public, signed, signed-upload)
// have the right shape but point at a non-serving host — server-side storage
// I/O (upload/download/remove) works, but flows where the BROWSER fetches or
// PUTs to a storage URL directly (FileBrowser signed uploads, takeoff/receipt
// direct uploads, rendering a public object URL) cannot round-trip under this
// mock. No current e2e spec exercises those; a spec that needs them requires
// real credentials in a non-production bucket, not this stub.

import type { SupabaseClient } from "@supabase/supabase-js";

type StoredObject = { bytes: Buffer; contentType: string };

// Host is deliberately fake but the URL keeps Supabase's real object-URL path
// shape (`/storage/v1/object/public/<bucket>/<path>`): cleanup code locates
// the storage path by slicing stored URLs at the `/<bucket>/` marker, and
// that must keep working on rows the stub created.
const MOCK_PUBLIC_HOST = "http://supabase-storage-mock.e2e.invalid";

const globalCache = globalThis as unknown as {
    __e2eStorageMockObjects?: Map<string, StoredObject>;
};

function objects(): Map<string, StoredObject> {
    globalCache.__e2eStorageMockObjects ??= new Map();
    return globalCache.__e2eStorageMockObjects;
}

function key(bucket: string, path: string): string {
    return `${bucket}/${path}`;
}

async function toBuffer(body: unknown): Promise<Buffer> {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (typeof body === "string") return Buffer.from(body);
    if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
    throw new Error(`E2E storage mock: unsupported upload body type (${typeof body})`);
}

function bucketApi(bucket: string) {
    return {
        async upload(
            path: string,
            body: unknown,
            options?: { contentType?: string; upsert?: boolean },
        ) {
            const k = key(bucket, path);
            if (objects().has(k) && !options?.upsert) {
                // Same message a real duplicate upload returns.
                return { data: null, error: { message: "The resource already exists" } };
            }
            objects().set(k, {
                bytes: await toBuffer(body),
                contentType: options?.contentType ?? "application/octet-stream",
            });
            return { data: { path }, error: null };
        },

        getPublicUrl(path: string) {
            return {
                data: {
                    publicUrl: `${MOCK_PUBLIC_HOST}/storage/v1/object/public/${bucket}/${path}`,
                },
            };
        },

        async remove(paths: string[]) {
            for (const path of paths) objects().delete(key(bucket, path));
            return { data: [], error: null };
        },

        async download(path: string) {
            const stored = objects().get(key(bucket, path));
            if (!stored) return { data: null, error: { message: "Object not found" } };
            return {
                data: new Blob([new Uint8Array(stored.bytes)], { type: stored.contentType }),
                error: null,
            };
        },

        async createSignedUrl(path: string, _ttlSeconds: number) {
            if (!objects().has(key(bucket, path))) {
                return { data: null, error: { message: "Object not found" } };
            }
            return {
                data: {
                    signedUrl: `${MOCK_PUBLIC_HOST}/storage/v1/object/sign/${bucket}/${path}?token=e2e-mock`,
                },
                error: null,
            };
        },

        async createSignedUploadUrl(path: string) {
            return {
                data: {
                    signedUrl: `${MOCK_PUBLIC_HOST}/storage/v1/object/upload/sign/${bucket}/${path}?token=e2e-mock`,
                    token: "e2e-mock",
                    path,
                },
                error: null,
            };
        },
    };
}

export function createStorageMockClient(): SupabaseClient {
    const client = {
        storage: {
            from: (bucket: string) => bucketApi(bucket),
        },
    };
    return client as unknown as SupabaseClient;
}
