// /api/studio-library — the org's custom finish + product library for the
// Room Studio. GET returns everything (any signed-in user); POST creates
// entries in bulk (ADMIN/MANAGER); DELETE removes one entry.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MESH_KEYS, CATEGORY_ORDER } from "@/lib/studio/catalog";

export const dynamic = "force-dynamic";

const FINISH_KINDS = ["cabinet", "paint", "floor", "counter", "tile"];
const MOUNTS = ["floor", "wall", "ceiling", "counter"];

async function getCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

export async function GET() {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const [finishes, products] = await Promise.all([
        prisma.catalogFinish.findMany({ orderBy: { name: "asc" } }),
        prisma.catalogProduct.findMany({ orderBy: { name: "asc" } }),
    ]);
    return NextResponse.json({
        finishes,
        products: products.map((p) => ({ ...p, price: p.price ? Number(p.price) : null })),
    });
}

interface FinishInput {
    kind?: string;
    name?: string;
    hex?: string;
    vendor?: string;
    sku?: string;
    priceNote?: string;
    notes?: string;
    sourceUrl?: string;
}

interface ProductInput {
    name?: string;
    vendor?: string;
    sku?: string;
    category?: string;
    mesh?: string;
    widthIn?: number;
    depthIn?: number;
    heightIn?: number;
    mount?: string;
    elevationIn?: number;
    price?: number;
    finishes?: Record<string, string>;
    sourceUrl?: string;
    notes?: string;
}

export async function POST(req: Request) {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["ADMIN", "MANAGER"].includes(caller.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: { finishes?: FinishInput[]; products?: ProductInput[] };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const finishes = (Array.isArray(body.finishes) ? body.finishes : [])
        .filter(
            (f) =>
                typeof f.name === "string" && f.name.trim() &&
                typeof f.kind === "string" && FINISH_KINDS.includes(f.kind) &&
                typeof f.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(f.hex),
        )
        .slice(0, 300)
        .map((f) => ({
            kind: f.kind!,
            name: f.name!.slice(0, 120),
            hex: f.hex!.toUpperCase(),
            vendor: strOrNull(f.vendor, 80),
            sku: strOrNull(f.sku, 60),
            priceNote: strOrNull(f.priceNote, 160),
            notes: strOrNull(f.notes, 400),
            sourceUrl: strOrNull(f.sourceUrl, 400),
        }));

    const products = (Array.isArray(body.products) ? body.products : [])
        .filter(
            (p) =>
                typeof p.name === "string" && p.name.trim() &&
                typeof p.category === "string" && (CATEGORY_ORDER as string[]).includes(p.category) &&
                typeof p.mesh === "string" && MESH_KEYS.includes(p.mesh) &&
                isDim(p.widthIn) && isDim(p.depthIn) && isDim(p.heightIn),
        )
        .slice(0, 300)
        .map((p) => ({
            name: p.name!.slice(0, 120),
            vendor: strOrNull(p.vendor, 80),
            sku: strOrNull(p.sku, 60),
            category: p.category!,
            mesh: p.mesh!,
            widthIn: p.widthIn!,
            depthIn: p.depthIn!,
            heightIn: p.heightIn!,
            mount: typeof p.mount === "string" && MOUNTS.includes(p.mount) ? p.mount : "floor",
            elevationIn: typeof p.elevationIn === "number" && p.elevationIn >= 0 && p.elevationIn <= 120 ? p.elevationIn : null,
            price: typeof p.price === "number" && p.price >= 0 && p.price < 1_000_000 ? p.price : null,
            finishes: p.finishes && typeof p.finishes === "object" ? p.finishes : undefined,
            sourceUrl: strOrNull(p.sourceUrl, 400),
            notes: strOrNull(p.notes, 400),
        }));

    const [createdFinishes, createdProducts] = await Promise.all([
        finishes.length ? prisma.catalogFinish.createMany({ data: finishes }) : { count: 0 },
        products.length ? prisma.catalogProduct.createMany({ data: products }) : { count: 0 },
    ]);

    return NextResponse.json({
        finishes: createdFinishes.count,
        products: createdProducts.count,
        skipped:
            (body.finishes?.length ?? 0) - finishes.length +
            ((body.products?.length ?? 0) - products.length),
    }, { status: 201 });
}

export async function DELETE(req: Request) {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["ADMIN", "MANAGER"].includes(caller.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const finishId = searchParams.get("finishId");
    const productId = searchParams.get("productId");
    if (!!finishId === !!productId) {
        return NextResponse.json({ error: "Provide exactly one of finishId or productId" }, { status: 400 });
    }
    if (finishId) await prisma.catalogFinish.delete({ where: { id: finishId } }).catch(() => undefined);
    if (productId) await prisma.catalogProduct.delete({ where: { id: productId } }).catch(() => undefined);
    return NextResponse.json({ success: true });
}

function strOrNull(v: unknown, max: number): string | null {
    return typeof v === "string" && v.trim() ? v.slice(0, max) : null;
}

function isDim(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 300;
}
