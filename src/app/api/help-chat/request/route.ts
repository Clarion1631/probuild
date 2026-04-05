import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { title, description, userId, currentPage } = await req.json();

  if (!title || !description || !userId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const result = await prisma.$queryRaw<any[]>`
      INSERT INTO "HelpRequest" ("userId", "type", "question", "response", "currentPage", "status")
      VALUES (${userId}, 'feature_request', ${title}, ${description}, ${currentPage || null}, 'open')
      RETURNING *
    `;

    return NextResponse.json({ request: result[0] });
  } catch (error) {
    console.error("Feature request error:", error);
    return NextResponse.json({ error: "Failed to save request" }, { status: 500 });
  }
}
