export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import { revalidatePath } from "next/cache";

let _db: any = null;
function getDb() {
    if (!_db) _db = new Database("dev.db");
    return _db;
}

function cuid() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export async function POST(req: NextRequest) {
    try {
        const { estimateId, itemId, amount, vendor, date, description, receiptUrl } = await req.json();

        if (!estimateId) {
            return NextResponse.json({ error: "estimateId is required" }, { status: 400 });
        }

        const db = getDb();

        if (itemId) {
            const itemExists = db.prepare("SELECT id FROM EstimateItem WHERE id = ?").get(itemId);
            if (!itemExists) {
                return NextResponse.json({ error: "This cost code is unsaved. Please click 'Save' on the Estimate first before adding an expense to it." }, { status: 400 });
            }
        }

        const id = cuid();

        db.prepare(`
            INSERT INTO Expense (id, estimateId, itemId, amount, vendor, date, description, receiptUrl, status, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            estimateId,
            itemId || null,
            parseFloat(amount) || 0,
            vendor || null,
            date ? new Date(date).getTime() : null,
            description || null,
            receiptUrl || null,
            "Pending",
            Date.now()
        );

        const newExpense = db.prepare("SELECT * FROM Expense WHERE id = ?").get(id);

        return NextResponse.json(newExpense);
    } catch (error: any) {
        console.error("Error creating expense:", error);
        return NextResponse.json({ error: "Failed to create expense", details: error?.message || String(error) }, { status: 500 });
    }
}
