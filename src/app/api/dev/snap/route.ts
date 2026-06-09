// Dev-only: save a canvas capture to disk so local tooling can inspect the
// WebGL framebuffer of a backgrounded tab (where OS-level screenshots can't).
// Hard-disabled outside development.

import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    if (process.env.NODE_ENV !== "development") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    let body: { dataUrl?: string; name?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const dataUrl = body.dataUrl ?? "";
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
    if (!m) return NextResponse.json({ error: "Expected image data URL" }, { status: 400 });

    const name = (body.name ?? "snap").replace(/[^a-z0-9-_]/gi, "").slice(0, 60) || "snap";
    const dir = path.join(process.cwd(), "qa-screenshots", "studio");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.${m[1] === "png" ? "png" : "jpg"}`);
    await writeFile(file, Buffer.from(m[2], "base64"));
    return NextResponse.json({ saved: file });
}
