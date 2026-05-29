import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const ALLOWED_STATUSES = new Set(["in_progress", "deployed", "verified"]);

function buildNotificationMessage(
  title: string,
  status: string,
  summary: string,
  deployUrl?: string
) {
  const statusText =
    status === "verified"
      ? "verified and ready"
      : status === "deployed"
        ? "deployed"
        : "in progress";

  return [
    `Update on bug fix "${title}": it has been ${statusText}.`,
    summary.trim(),
    deployUrl ? `Deployment: ${deployUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function POST(req: NextRequest) {
  const secret = process.env.PHANTOM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 503 }
    );
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { issueNumber, status, summary, deployUrl } = await req.json();

  if (
    !issueNumber ||
    typeof issueNumber !== "number" ||
    !summary ||
    typeof summary !== "string" ||
    !ALLOWED_STATUSES.has(status)
  ) {
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 }
    );
  }

  const externalIssueRef = `github-issue:${issueNumber}`;

  try {
    const request = await prisma.helpRequest.findFirst({
      where: { externalIssueRef },
      orderBy: { createdAt: "desc" },
    });

    if (!request) {
      return NextResponse.json(
        { error: "Help request not found" },
        { status: 404 }
      );
    }

    const completedAt = status === "deployed" || status === "verified"
      ? new Date()
      : null;
    const verifiedAt = status === "verified" ? new Date() : null;

    await prisma.helpRequest.update({
      where: { id: request.id },
      data: {
        status,
        changeDescription: summary.trim(),
        ...(completedAt && { completedAt }),
        ...(verifiedAt && { verifiedAt }),
        ...(deployUrl && { changeLocation: deployUrl }),
      },
    });

    if (!request.conversationId) {
      console.warn(
        `[HelpChatWebhook] Request ${request.id} has no conversationId`
      );
      return NextResponse.json({ ok: true, notificationPosted: false });
    }

    const conversation = await prisma.chatConversation.findUnique({
      where: { id: request.conversationId },
      select: { id: true },
    });

    if (!conversation) {
      console.warn(
        `[HelpChatWebhook] Conversation ${request.conversationId} no longer exists`
      );
      return NextResponse.json({ ok: true, notificationPosted: false });
    }

    const message = buildNotificationMessage(
      request.question,
      status,
      summary,
      deployUrl
    );

    await prisma.$transaction([
      prisma.chatMessage.create({
        data: {
          conversationId: request.conversationId,
          role: "assistant",
          content: message,
        },
      }),
      prisma.chatConversation.update({
        where: { id: request.conversationId },
        data: { archivedAt: null, updatedAt: new Date() },
      }),
    ]);

    return NextResponse.json({ ok: true, notificationPosted: true });
  } catch (error) {
    console.error("Bug fix webhook error:", error);
    return NextResponse.json(
      { error: "Failed to process webhook" },
      { status: 500 }
    );
  }
}
