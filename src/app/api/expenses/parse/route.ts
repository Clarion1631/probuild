export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("receipt") as File;

    if (!file) {
      return NextResponse.json({ error: "No receipt file provided" }, { status: 400 });
    }

    // Save file locally for now
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Create uploads directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), "public", "uploads", "receipts");
    await mkdir(uploadDir, { recursive: true });

    const extension = file.name.split(".").pop() || "jpg";
    const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${extension}`;
    const filePath = path.join(uploadDir, filename);
    await writeFile(filePath, buffer);

    const publicUrl = `/uploads/receipts/${filename}`;

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "AI Parsing is not configured on this server." },
        { status: 500 }
      );
    }

    const safeMime = (
      ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)
        ? file.type
        : "image/jpeg"
    ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: safeMime, data: buffer.toString("base64") },
            },
            {
              type: "text",
              text: "Extract the following from this receipt: amount (number), vendor name, date (YYYY-MM-DD), and a brief description of what was purchased. Return ONLY a valid JSON object with the keys 'amount', 'vendor', 'date', and 'description'.",
            },
          ],
        },
      ],
    });

    const aiText = (response.content[0] as { type: "text"; text: string }).text || "";
    // Extremely simple JSON extraction just in case it's wrapped in markdown
    const jsonMatch = aiText.match(/```json\n([\s\S]*?)\n```/) || aiText.match(/\{[\s\S]*\}/);
    let entryData = {};
    if (jsonMatch) {
      try {
        entryData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } catch {
        // AI returned unparseable JSON — fall through to empty entryData
      }
    }

    return NextResponse.json({
      receiptUrl: publicUrl,
      parsedData: entryData,
      rawAiText: aiText, // for debugging if needed
    });
  } catch {
    return NextResponse.json({ error: "Failed to parse receipt" }, { status: 500 });
  }
}
