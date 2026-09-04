import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicHelpRequest } from "@/lib/help-chat/submission-guard";

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

    // Projected like every other help-chat response. `SELECT *` here means the
    // provider lease token was in this body too - and "only admins see it" is
    // not a reason to hand out a capability (round 10, finding 5).
    return NextResponse.json({ requests: requests.map((row) => toPublicHelpRequest(row)) });
  } catch (error) {
    console.error("Help history error:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}
