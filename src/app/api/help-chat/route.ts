import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI service not configured" },
      { status: 503 }
    );
  }

  const { question, currentPage, userId, userRole } = await req.json();

  if (!question || !userId) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are a ProBuild help assistant. ProBuild is a construction/remodeling management platform with features for projects, estimates, invoices, leads, time tracking, daily logs, schedules, and reports. The user is on page "${currentPage || "unknown"}". Their role is ${userRole || "USER"}. Answer their question about how to use ProBuild concisely. If the question is about a feature that doesn't exist yet, respond with ONLY a valid JSON object: {"type": "feature_request", "title": "short title", "description": "detailed description"} — nothing else, no markdown wrapping.`,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anthropic API error:", err);
      return NextResponse.json(
        { error: "AI service error" },
        { status: 502 }
      );
    }

    const data = await response.json();
    const text =
      data.content?.[0]?.type === "text" ? data.content[0].text : "";

    // Check if the response is a feature request JSON
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed.type === "feature_request") {
        return NextResponse.json({
          answer: `This looks like a feature request: "${parsed.title}"`,
          type: "feature_request",
          title: parsed.title,
          description: parsed.description,
        });
      }
    } catch {
      // Not JSON — it's a normal help response
    }

    return NextResponse.json({ answer: text, type: "help" });
  } catch (error) {
    console.error("Help chat error:", error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
