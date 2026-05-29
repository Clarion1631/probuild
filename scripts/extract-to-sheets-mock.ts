import { prisma } from '../src/lib/prisma';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load site's .env
dotenv.config();

const mockDbPath = path.join(__dirname, '../../gtr-probuild-google-engine/scratch/mock_gsdb.json');

// Utility to format date to YYYY-MM-DD
function formatDate(date?: Date | string | null): string {
    if (!date) return new Date().toISOString().split('T')[0];
    const d = new Date(date);
    if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
    return d.toISOString().split('T')[0];
}

// Utility to format time to HH:MM:SS
function formatTime(date?: Date | string | null): string {
    if (!date) return "08:00:00";
    const d = new Date(date);
    if (isNaN(d.getTime())) return "08:00:00";
    return d.toTimeString().split(' ')[0];
}

async function runStagingPipeline() {
    console.log("===============================================================================");
    console.log("📥 DIRECT PRISMA STAGING PIPELINE TO GOOGLE ENGINE GSDB...");
    console.log(`🔌 Destination Mock GSDB: ${mockDbPath}`);
    console.log("===============================================================================\n");

    try {
        // Test database connection
        console.log("[Status] Connecting to PostgreSQL via Prisma...");
        const userCount = await prisma.user.count();
        console.log(`✅ Connected successfully! Found ${userCount} users registered in the database.\n`);

        console.log("[Status] Fetching database collections from live PostgreSQL...");
        const [
            users,
            clients,
            projects,
            estimateItems,
            expenses,
            timeEntries
        ] = await Promise.all([
            prisma.user.findMany(),
            prisma.client.findMany(),
            prisma.project.findMany(),
            prisma.estimateItem.findMany({
                include: {
                    estimate: true,
                    costCode: true
                }
            }),
            prisma.expense.findMany({
                include: {
                    costCode: true
                }
            }),
            prisma.timeEntry.findMany({
                include: {
                    user: true,
                    project: true
                }
            })
        ]);

        console.log(`🔍 Live Database Record Summary:
           - Users (Crew): ${users.length}
           - Clients: ${clients.length}
           - Projects: ${projects.length}
           - EstimateItems: ${estimateItems.length}
           - Expenses: ${expenses.length}
           - Time Entries: ${timeEntries.length}
        `);

        // Map Estimate Items to Estimates tab
        console.log("[Map] Staging Estimates & Items...");
        const stagedEstimates = estimateItems
            .filter(item => item.estimate && item.estimate.status !== 'Archived')
            .map(item => {
                const codeString = item.costCode ? item.costCode.code : (item.costCodeId || "06-100");
                
                let division = "01 General";
                if (codeString.startsWith("02")) division = "02 Site Work";
                else if (codeString.startsWith("03")) division = "03 Concrete";
                else if (codeString.startsWith("06")) division = "06 Wood & Plastics";
                else if (codeString.startsWith("09")) division = "09 Finishes";
                else if (codeString.startsWith("22")) division = "22 Plumbing";
                else if (codeString.startsWith("26")) division = "26 Electrical";

                const baseCost = item.baseCost ? Number(item.baseCost) : Number(item.unitCost || 0);
                const quantity = item.quantity || 1;
                const rawSubtotal = quantity * baseCost;
                const markup = (item.markupPercent || 25) / 100;
                const clientPrice = item.total ? Number(item.total) : (rawSubtotal * (1 + markup));

                return {
                    Division: division,
                    CostCode: codeString,
                    ItemDescription: `${item.name}${item.description ? ' - ' + item.description : ''}`,
                    Quantity: quantity,
                    Unit: "EA",
                    UnitCost: baseCost,
                    RawSubtotal: rawSubtotal,
                    Markup: markup,
                    ClientPrice: clientPrice,
                    Status: item.approvalStatus === 'approved' ? 'Approved' : 'Draft',
                    ChangeOrderRef: ""
                };
            });

        // Map Expenses to Job Costing tab
        console.log("[Map] Staging Expenditures & Material Costing...");
        const stagedExpenses = expenses.map(exp => {
            const codeString = exp.costCode ? exp.costCode.code : (exp.costCodeId || "06-100");
            const actualCost = Number(exp.amount || 0);
            
            return {
                TransactionDate: formatDate(exp.date || exp.createdAt),
                Vendor: exp.vendor || "Lowe's",
                Description: exp.description || "Material Expense",
                CostCode: codeString,
                EstimatedBudget: 1500, // Lookup fallback
                ActualCost: actualCost,
                Variance: 1500 - actualCost,
                ReceiptURL: exp.receiptUrl || "https://drive.google.com/open?id=staged_rec",
                SyncStatus: exp.status === 'Reviewed' ? 'Synced QBO' : 'Pending QBO'
            };
        });

        // Map Time Entries to Time Sheets tab
        console.log("[Map] Staging Crew Time Sheets...");
        const stagedTimeSheets = timeEntries.map(te => {
            const empName = te.user ? (te.user.name || te.user.email) : "Crew Member";
            const jobName = te.project ? te.project.name : "Staged Job";
            const duration = te.durationHours || 8.0;

            return {
                Date: formatDate(te.startTime),
                EmployeeName: empName,
                JobName: jobName,
                ClockIn: formatTime(te.startTime),
                ClockOut: te.endTime ? formatTime(te.endTime) : "17:00:00",
                BreakStart: "12:00:00",
                BreakEnd: "12:30:00",
                TotalHours: duration,
                OvertimeHours: duration > 8 ? duration - 8 : 0,
                SafetyCheck: "Passed",
                BreakWarning: "OK",
                GustoSync: "Synced Gusto"
            };
        });

        // Map Payments
        console.log("[Map] Staging Client Payments...");
        const stagedPayments = estimateItems
            .filter(item => item.estimate && item.estimate.status === 'Approved')
            .map((item, idx) => {
                const total = Number(item.estimate.totalAmount || 5000);
                const amt = total * 0.50; // Stage 50% deposit
                
                return {
                    PaymentDate: formatDate(item.estimate.approvedAt || item.estimate.createdAt),
                    ReceiptNumber: `REC-${1000 + idx}`,
                    InvoiceRef: `EST-${item.estimate.id.slice(-4).toUpperCase()}`,
                    AmountPaid: amt,
                    PaymentMethod: "Check",
                    TaxableSubtotal: amt / 1.0825,
                    SalesTaxRate: 0.0825,
                    SalesTaxPortion: amt - (amt / 1.0825),
                    QBOSyncRef: "Synced"
                };
            });

        if (stagedPayments.length === 0) {
            stagedPayments.push({
                PaymentDate: "2026-05-15",
                ReceiptNumber: "REC-4029",
                InvoiceRef: "EST-9832",
                AmountPaid: 7500.00,
                PaymentMethod: "Check",
                TaxableSubtotal: 6928.41,
                SalesTaxRate: 0.0825,
                SalesTaxPortion: 571.59,
                QBOSyncRef: "QBO-PAY-983"
            });
        }

        // Overhead seeds
        console.log("[Map] Staging General Operating Overheads...");
        const stagedOverhead = [
            { Category: "Rent", Vendor: "Commercial Realty Group", Description: "Warehouse and Office Storage", Amount: 2400.00, Frequency: "Monthly", MonthlyBurden: 2400.00 },
            { Category: "Insurance", Vendor: "State Farm", Description: "General Liability & Worker's Comp", Amount: 6000.00, Frequency: "Annually", MonthlyBurden: 500.00 },
            { Category: "Software Licensing", Vendor: "Google Workspace & Vercel", Description: "Apps ecosystem & site hosting", Amount: 150.00, Frequency: "Monthly", MonthlyBurden: 150.00 },
            { Category: "Office Admin Salary", Vendor: "Golden Touch payroll", Description: "Administrative bookkeeping support", Amount: 3000.00, Frequency: "Monthly", MonthlyBurden: 3000.00 }
        ];

        // Client Progress Feed
        console.log("[Map] Staging Client Progress Stories...");
        const stagedProgressFeed = projects
            .filter(p => p.status === 'In Progress')
            .map(p => ({
                PublishDate: formatDate(p.createdAt),
                ActivePhase: "Rough-Ins",
                ProgressCardSummary: `Status update for ${p.name}! We have completed the structural framing and are currently installing rough-in plumbing and electrical components. The schedule is moving exactly as estimated.`,
                PhotoAlbumLink: `https://photos.google.com/album/${p.name.toLowerCase().replace(/ /g, '_')}`,
                VideoWalkthroughURL: "https://drive.google.com/open?id=video_staged",
                PaymentReference: "REC-4029"
            }));

        if (stagedProgressFeed.length === 0) {
            stagedProgressFeed.push({
                PublishDate: "2026-05-19",
                ActivePhase: "Framing",
                ProgressCardSummary: "Kitchen island structural framing and bathroom niche support are complete. Weatherproof seal approved. Rough-in electrical inspections start tomorrow morning.",
                PhotoAlbumLink: "https://photos.google.com/album/smith_kitchen",
                VideoWalkthroughURL: "https://drive.google.com/open?id=video_staged_01",
                PaymentReference: "REC-4029"
            });
        }

        // 8. Commit to sheets mock database
        console.log("\n[Write] Writing formatted datasets into Sheets Database register tabs...");
        const stagedDb = {
            Estimates: stagedEstimates.length > 0 ? stagedEstimates : [
                { Division: "06 Wood & Plastics", CostCode: "06-100", ItemDescription: "Framing Lumber Studs", Quantity: 100, Unit: "EA", UnitCost: 15, RawSubtotal: 1500, Markup: 0.20, ClientPrice: 1800, Status: "Approved", ChangeOrderRef: "" },
                { Division: "09 Finishes", CostCode: "09-300", ItemDescription: "Carrara Marble Tile Bath niche", Quantity: 120, Unit: "SF", UnitCost: 12, RawSubtotal: 1440, Markup: 0.20, ClientPrice: 1728, Status: "Approved", ChangeOrderRef: "" }
            ],
            JobCosting: stagedExpenses.length > 0 ? stagedExpenses : [
                { TransactionDate: "2026-05-18", Vendor: "Lowe's", Description: "Matte Black Drawer Handles", CostCode: "09-300", EstimatedBudget: 1728, ActualCost: 97.43, Variance: 1630.57, ReceiptURL: "https://drive.google.com/open?id=rec_staged_01", SyncStatus: "Pending QBO" },
                { TransactionDate: "2026-05-19", Vendor: "Amazon", Description: "PVC Piping joint enclosures", CostCode: "22-100", EstimatedBudget: 540, ActualCost: 45.00, Variance: 495.00, ReceiptURL: "https://drive.google.com/open?id=rec_staged_02", SyncStatus: "Synced QBO" }
            ],
            TimeSheets: stagedTimeSheets.length > 0 ? stagedTimeSheets : [{
                Date: "2026-05-19",
                EmployeeName: "Richard (PM)",
                JobName: "Smith Kitchen Remodel",
                ClockIn: "07:30:00",
                ClockOut: "16:00:00",
                BreakStart: "12:00:00",
                BreakEnd: "12:30:00",
                TotalHours: 8.0,
                OvertimeHours: 0,
                SafetyCheck: "Passed",
                BreakWarning: "OK",
                GustoSync: "Synced Gusto"
            }],
            Payments: stagedPayments,
            MasterOverhead: stagedOverhead,
            ClientProgressFeed: stagedProgressFeed
        };

        const dir = path.dirname(mockDbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(mockDbPath, JSON.stringify(stagedDb, null, 2));

        console.log("\n===============================================================================");
        console.log("🎉 PRISMA DATABASE STAGING COMPLETED SUCCESSFULLY!");
        console.log(`📊 Total Staged Rows Written to GSDB Mock JSON:
           ✅ Estimates Tab: ${stagedDb.Estimates.length} items
           ✅ JobCosting Tab: ${stagedDb.JobCosting.length} expenditures
           ✅ TimeSheets Tab: ${stagedDb.TimeSheets.length} labor entries
           ✅ Payments Tab: ${stagedDb.Payments.length} deposits
           ✅ MasterOverhead Tab: ${stagedDb.MasterOverhead.length} operating charges
           ✅ ClientProgressFeed Tab: ${stagedDb.ClientProgressFeed.length} feed entries
        `);
        console.log("===============================================================================");

    } catch (err) {
        console.error("❌ Staging run encountered critical failure:", err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

runStagingPipeline();
