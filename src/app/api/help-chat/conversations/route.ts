import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as any).id;
  if (!userId) {
    return NextResponse.json({ conversation: null });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "active"; // active | archived | search
  const query = url.searchParams.get("q") || "";

  try {
    // Auto-archive conversations older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await prisma.chatConversation.updateMany({
      where: {
        userId,
        archivedAt: null,
        updatedAt: { lt: sevenDaysAgo },
      },
      data: { archivedAt: new Date() },
    });

    if (mode === "search" && query) {
      // Search across all conversations (active + archived) by message content
      const conversations = await prisma.chatConversation.findMany({
        where: {
          userId,
          messages: {
            some: {
              content: { contains: query, mode: "insensitive" },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        include: {
          messages: {
            where: {
              content: { contains: query, mode: "insensitive" },
            },
            take: 1,
            select: { content: true, role: true },
          },
          _count: { select: { messages: true } },
        },
      });

      return NextResponse.json({
        conversations: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          archived: !!c.archivedAt,
          updatedAt: c.updatedAt,
          messageCount: c._count.messages,
          matchPreview: c.messages[0]?.content.slice(0, 100),
        })),
      });
    }

    if (mode === "archived") {
      // List archived conversations
      const conversations = await prisma.chatConversation.findMany({
        where: { userId, archivedAt: { not: null } },
        orderBy: { updatedAt: "desc" },
        take: 20,
        include: {
          _count: { select: { messages: true } },
        },
      });

      return NextResponse.json({
        conversations: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          archivedAt: c.archivedAt,
          messageCount: c._count.messages,
        })),
      });
    }

    // Default: get the most recent active (non-archived) conversation
    const conversation = await prisma.chatConversation.findFirst({
      where: { userId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          take: 50,
          select: { role: true, content: true },
        },
      },
    });

    if (!conversation || conversation.messages.length === 0) {
      return NextResponse.json({ conversation: null });
    }

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        messages: conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      },
    });
  } catch (error) {
    console.error("Load conversation error:", error);
    return NextResponse.json(
      { error: "Failed to load conversation" },
      { status: 500 }
    );
  }
}

// PATCH — restore an archived conversation or manually archive one
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as any).id;
  const { conversationId, action } = await req.json();

  if (!conversationId || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  try {
    // Verify ownership
    const convo = await prisma.chatConversation.findFirst({
      where: { id: conversationId, userId },
    });
    if (!convo) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (action === "restore") {
      await prisma.chatConversation.update({
        where: { id: conversationId },
        data: { archivedAt: null, updatedAt: new Date() },
      });
    } else if (action === "archive") {
      await prisma.chatConversation.update({
        where: { id: conversationId },
        data: { archivedAt: new Date() },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Conversation action error:", error);
    return NextResponse.json(
      { error: "Failed to update conversation" },
      { status: 500 }
    );
  }
}
