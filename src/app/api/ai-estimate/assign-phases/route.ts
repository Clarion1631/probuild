import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { matchItemsToCostCodes } from "@/lib/auto-assign-phases";

type ItemInput = {
  id: string;
  name: string;
  description: string;
};

type CostCodeInput = {
  id: string;
  code: string;
  name: string;
};

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  let items: ItemInput[];
  let costCodes: CostCodeInput[];
  try {
    ({ items, costCodes } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items array is required" }, { status: 400 });
  }

  if (!costCodes || !Array.isArray(costCodes) || costCodes.length === 0) {
    return NextResponse.json({ error: "costCodes array is required" }, { status: 400 });
  }

  if (items.length > 500 || costCodes.length > 200) {
    return NextResponse.json({ error: "Too many items or cost codes" }, { status: 400 });
  }

  // Normalize and cap every field that reaches the prompt — count caps alone
  // don't bound prompt size, and null/non-string entries must not throw.
  const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const safeItems = items
    .filter((it) => !!it && typeof it === "object")
    .map((it) => ({ id: str(it.id, 100), name: str(it.name, 200), description: str(it.description, 500) }))
    .filter((it) => it.id);
  const safeCostCodes = costCodes
    .filter((cc) => !!cc && typeof cc === "object")
    .map((cc) => ({ id: str(cc.id, 100), code: str(cc.code, 50), name: str(cc.name, 100) }))
    .filter((cc) => cc.id);

  if (safeItems.length === 0 || safeCostCodes.length === 0) {
    return NextResponse.json({ error: "No valid items or cost codes" }, { status: 400 });
  }

  try {
    const assignments = await matchItemsToCostCodes(safeItems, safeCostCodes);
    return NextResponse.json({ assignments });
  } catch (err) {
    console.error("AI Assign Phases error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    const status = message === "No response from AI" || message === "Could not parse AI response" ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
