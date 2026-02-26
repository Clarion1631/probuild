import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";

let _db: any = null;
function getDb() {
    if (!_db) _db = new Database("dev.db");
    return _db;
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const db = getDb();
        db.prepare("DELETE FROM Expense WHERE id = ?").run(id);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting expense:", error);
        return NextResponse.json({ error: "Failed to delete expense" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const body = await req.json();
        const db = getDb();

        if (body.itemId) {
            const itemExists = db.prepare("SELECT id FROM EstimateItem WHERE id = ?").get(body.itemId);
            if (!itemExists) {
                return NextResponse.json({ error: "This cost code is unsaved. Please click 'Save' on the Estimate first before moving an expense to it." }, { status: 400 });
            }
        }

        db.prepare(`
            UPDATE Expense
            SET amount = ?, vendor = ?, date = ?, description = ?, itemId = ?
            WHERE id = ?
        `).run(
            body.amount ? parseFloat(body.amount) : null,
            body.vendor || null,
            body.date ? new Date(body.date).getTime() : null,
            body.description || null,
            body.itemId || null,
            id
        );

        const updatedExpense = db.prepare("SELECT * FROM Expense WHERE id = ?").get(id);

        return NextResponse.json(updatedExpense);
    } catch (error) {
        console.error("Error updating expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
