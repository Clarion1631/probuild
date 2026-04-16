// next/og dynamic OG image for the share link. Rendering the 3D scene server-
// side would be too heavy on a cold edge instance, so this is a lightweight
// HTML-to-PNG card with contractor branding + a "View 3D Design" CTA. The
// real design pops in once the client follows the link.

import { ImageResponse } from "next/og";
import { prisma } from "@/lib/prisma";
import { isValidShareToken } from "@/lib/room-designer/share-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // prisma needs Node.js runtime, not edge
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface Props { params: Promise<{ token: string }> }

export default async function Image({ params }: Props) {
    const { token } = await params;

    let contractorName = "ProBuild";
    let roomLabel = "Your Design";
    let logoUrl: string | null = null;

    if (isValidShareToken(token)) {
        const room = await prisma.roomDesign.findFirst({
            where: { shareToken: token, shareEnabled: true },
            include: {
                project: { select: { name: true } },
                lead: { select: { name: true } },
            },
        });
        if (room) {
            const owner = room.project?.name ?? room.lead?.name ?? "Room";
            roomLabel = `${owner} — ${room.name}`;
            const settings = await prisma.companySettings.findFirst({
                select: { companyName: true, logoUrl: true },
            });
            if (settings?.companyName) contractorName = settings.companyName;
            if (settings?.logoUrl) logoUrl = settings.logoUrl;
        }
    }

    return new ImageResponse(
        (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    background: "linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)",
                    color: "white",
                    padding: "56px 72px",
                    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                    {logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={logoUrl}
                            alt=""
                            width={72}
                            height={72}
                            style={{ borderRadius: 12, objectFit: "contain", background: "white", padding: 8 }}
                        />
                    ) : null}
                    <div style={{ fontSize: 36, fontWeight: 700 }}>{contractorName}</div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 28, color: "#cbd5e1" }}>Room Design</div>
                    <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.05 }}>
                        {truncate(roomLabel, 60)}
                    </div>
                </div>

                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 14,
                            padding: "14px 26px",
                            borderRadius: 999,
                            background: "white",
                            color: "#0f172a",
                            fontSize: 26,
                            fontWeight: 600,
                        }}
                    >
                        View 3D design →
                    </div>
                    <div style={{ fontSize: 20, color: "#94a3b8" }}>Powered by ProBuild</div>
                </div>
            </div>
        ),
        { ...size },
    );
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
