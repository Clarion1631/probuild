import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const userId = (session.user as any).id;

  try {
    const requests = await prisma.$queryRaw<any[]>`
      SELECT * FROM "HelpRequest"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
    `;

    return NextResponse.json({ requests });
  } catch (error) {
    console.error("Help history error:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}
