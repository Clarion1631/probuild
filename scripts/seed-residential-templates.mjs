// One-off importer: replace DocumentTemplate rows with the Residential Remodel
// contract pack. Source files live in:
//   C:\Users\jat00\Downloads\Residential Remodel\Residential Remodel\
// Reads .docx via mammoth; the lone .doc (Express Limited Home Warranty) is
// imported from the matching PDF via pdf-parse since LibreOffice isn't installed.
//
// Run: node scripts/seed-residential-templates.mjs

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_ROOT = "C:/Users/jat00/Downloads/Residential Remodel/Residential Remodel";
const WORD_DIR = path.join(SRC_ROOT, "Word");
const PDF_DIR = path.join(SRC_ROOT, "PDF");

// One row per signable contract document. Order is display order in the UI.
// `isDefault: true` only on the most-common variant of each type.
const CONTRACTS = [
    {
        file: "Residential Remodel Lump Sum Contract.docx",
        name: "Residential Remodel — Lump Sum Contract",
        type: "contract",
        isDefault: true,
    },
    {
        file: "Residential Remodel Cost Plus Contract.docx",
        name: "Residential Remodel — Cost Plus Contract",
        type: "contract",
        isDefault: false,
    },
    {
        file: "Residential Remodel Change Order Form.docx",
        name: "Change Order Form",
        type: "change_order",
        isDefault: true,
    },
    {
        file: "Residential Remodel Draw Request Form.docx",
        name: "Draw Request Form",
        type: "draw_request",
        isDefault: true,
    },
    {
        file: "Residential Remodel Conditional Lien Release.docx",
        name: "Conditional Lien Release",
        type: "lien_release",
        isDefault: true,
    },
    {
        file: "Residential Remodel Final Lien Release.docx",
        name: "Final Lien Release",
        type: "lien_release",
        isDefault: false,
    },
    {
        file: "Residential Remodel Express Limited Home Warranty.doc",
        pdfFile: "Residential Remodel Express Limited Home Warranty.pdf",
        name: "Express Limited Home Warranty",
        type: "warranty",
        isDefault: true,
    },
    {
        file: "Residential Remodel Assignment of Manufacturer's Product Warranties.docx",
        name: "Assignment of Manufacturer's Product Warranties",
        type: "warranty",
        isDefault: false,
    },
    {
        file: "Residential Remodel Final Customer Walk Through Punchlist.docx",
        name: "Final Customer Walk-Through Punchlist",
        type: "punch_list",
        isDefault: true,
    },
    {
        file: "Residential Remodel Special Provisions Addendum.docx",
        name: "Special Provisions Addendum",
        type: "addendum",
        isDefault: true,
    },
    {
        file: "Residential Remodel Lead Based Paint Addendum.docx",
        name: "Lead-Based Paint Addendum",
        type: "addendum",
        isDefault: false,
    },
    {
        file: "Residential Remodel Disclosure Statement Notice to Customer.docx",
        name: "Disclosure Statement — Notice to Customer",
        type: "disclaimer",
        isDefault: true,
    },
];

function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// pdf-parse returns plain text with newlines. Wrap blank-line-separated
// blocks in <p>...</p> so the editor renders something legible.
function pdfTextToHtml(text) {
    const blocks = text
        .replace(/\r\n/g, "\n")
        .split(/\n{2,}/)
        .map(b => b.trim())
        .filter(Boolean);
    return blocks
        .map(block => {
            const inner = escapeHtml(block).replace(/\n/g, "<br/>");
            return `<p>${inner}</p>`;
        })
        .join("\n");
}

async function convertDocxToHtml(absPath) {
    const buffer = await fsp.readFile(absPath);
    const result = await mammoth.convertToHtml({ buffer });
    return { html: result.value, messages: result.messages };
}

async function convertDocViaPdf(pdfAbsPath) {
    // pdf-parse v2.x exposes a class-based API.
    const { PDFParse } = await import("pdf-parse");
    const buffer = await fsp.readFile(pdfAbsPath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = await parser.getText();
        return { html: pdfTextToHtml(result.text), messages: [] };
    } finally {
        await parser.destroy();
    }
}

function autoPopulateMergeFields(name, body) {
    const partiesTableSrc = `<p><strong>PARTIES</strong>:</p><table style="width:100%;border-collapse:collapse;margin:8px 0 16px 0"><tbody><tr><td style="width:50%;padding:3px 12px 3px 0;font-weight:bold">"Owner"</td><td style="width:50%;padding:3px 0 3px 12px;font-weight:bold">"Contractor"</td></tr><tr><td style="padding:3px 12px 3px 0">Name: ________________________</td><td style="padding:3px 0 3px 12px">Name: ________________________</td></tr><tr><td style="padding:3px 12px 3px 0">Address: ________________________</td><td style="padding:3px 0 3px 12px">Address: ________________________</td></tr><tr><td style="padding:3px 12px 3px 0">________________________</td><td style="padding:3px 0 3px 12px">________________________</td></tr><tr><td style="padding:3px 12px 3px 0">Phone No: ________________________</td><td style="padding:3px 0 3px 12px">Phone No: ________________________</td></tr><tr><td style="padding:3px 12px 3px 0">Email: ________________________</td><td style="padding:3px 0 3px 12px">Email: ________________________</td></tr></tbody></table><p><strong>“PROPERTY” </strong></p><p>Address: &emsp;__________________________________________________________________</p><p>County:&emsp;__________________________________________________________________</p><p>Tax Parcel No: _________________________________________________________________</p><p><strong>DATE</strong>:&emsp;­­________________________</p>`;

    const partiesTableDest = `<p><strong>PARTIES</strong>:</p><table style="width:100%;border-collapse:collapse;margin:8px 0 16px 0"><tbody><tr><td style="width:50%;padding:3px 12px 3px 0;font-weight:bold">"Owner"</td><td style="width:50%;padding:3px 0 3px 12px;font-weight:bold">"Contractor"</td></tr><tr><td style="padding:3px 12px 3px 0">Name: {{client_name}}</td><td style="padding:3px 0 3px 12px">Name: {{company_name}}</td></tr><tr><td style="padding:3px 12px 3px 0">Address: {{client_address}}</td><td style="padding:3px 0 3px 12px">Address: {{company_address}}</td></tr><tr><td style="padding:3px 12px 3px 0">Phone No: {{client_phone}}</td><td style="padding:3px 0 3px 12px">Phone No: {{company_phone}}</td></tr><tr><td style="padding:3px 12px 3px 0">Email: {{client_email}}</td><td style="padding:3px 0 3px 12px">Email: {{company_email}}</td></tr></tbody></table><p><strong>“PROPERTY” </strong></p><p>Address: &emsp;{{location}}</p><p>County:&emsp;__________________________________________________________________</p><p>Tax Parcel No: _________________________________________________________________</p><p><strong>DATE</strong>:&emsp;{{date}}</p>`;

    let res = body;
    if (name === "Draw Request Form") {
        res = res
            .replace("Date : ________________________", "Date: {{date}}")
            .replace("Project Address : &emsp;__________________________________________________________________", "Project Address : &emsp;{{location}}")
            .replace("Pursuant to that (Name of Residential Contract)", "Pursuant to that {{project_name}}")
            .replace("(Name of Contractor) requests", "{{company_name}} requests")
            .replace("Project Name: &emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;", "Project Name: &emsp;{{project_name}}")
            .replace("Contractor:&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;", "Contractor:&emsp;{{company_name}}")
            .replace("Property Address: &emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;", "Property Address:&emsp;{{location}}")
            .replace("Date of Request: &emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;", "Date of Request:&emsp;{{date}}")
            .replace("Name of Contractor: ___________________________", "Name of Contractor: {{company_name}}");
    } else if (name === "Residential Remodel — Cost Plus Contract" || name === "Special Provisions Addendum") {
        res = res.replace(partiesTableSrc, partiesTableDest);
    } else if (name === "Conditional Lien Release" || name === "Final Lien Release") {
        res = res
            .replace("Claimant(s) : _________________________________", "Claimant(s) : {{company_name}}")
            .replace("Project : _______________________________________________________________", "Project : {{project_name}}")
            .replace("Property Address : ___________________________________________________________", "Property Address : {{location}}")
            .replace("Property Owner : ______________________________________________", "Property Owner : {{client_name}}")
            .replace("Date: ______________________________", "Date: {{date}}")
            .replace(/\[CLAIMANT COMPANY NAME\]/g, "{{company_name}}");
    } else if (name === "Assignment of Manufacturer's Product Warranties") {
        res = res
            .replace("by and between _____________________", "by and between {{company_name}}")
            .replace("and ____________________ (“Owner”)", "and {{client_name}} (“Owner”)")
            .replace("pursuant to that certain ________________________ Contract", "pursuant to that certain {{project_name}} Contract")
            .replace("dated ___________________ (the “Agreement”)", "dated {{date}} (the “Agreement”)")
            .replace("Owner: __________________________ &emsp;&emsp;&emsp;&emsp;Date: _______________", "Owner: {{client_name}} &emsp;&emsp;&emsp;&emsp;Date: {{date}}")
            .replace("Contractor: __________________________ &emsp;&emsp;&emsp;Date: _______________", "Contractor: {{company_name}} &emsp;&emsp;&emsp;Date: {{date}}");
    } else if (name === "Express Limited Home Warranty") {
        res = res
            .replace("Owner: _____________________________________________", "Owner: {{client_name}}")
            .replace("Project Address: ___________________________________________________", "Project Address: {{location}}")
            .replace("Contract Date: ___________________", "Contract Date: {{date}}");
    }
    return res;
}

async function main() {
    // Phase 1: convert all files in memory — no DB writes yet.
    console.log("→ Converting files...");
    const rows = [];
    const conversionResults = [];

    for (const c of CONTRACTS) {
        const wordPath = path.join(WORD_DIR, c.file);
        let html, conversionPath, warnings = [];

        if (!fs.existsSync(wordPath)) {
            console.error(`  MISSING: ${wordPath}`);
            conversionResults.push({ name: c.name, type: c.type, isDefault: c.isDefault, htmlBytes: 0, conversionPath: "MISSING" });
            continue;
        }

        try {
            if (c.file.toLowerCase().endsWith(".docx")) {
                const out = await convertDocxToHtml(wordPath);
                html = out.html;
                conversionPath = "mammoth(.docx)";
                warnings = out.messages;
            } else if (c.file.toLowerCase().endsWith(".doc")) {
                // True OLE Word 97-2003 binary — skip mammoth, use the PDF.
                const pdfPath = path.join(PDF_DIR, c.pdfFile);
                if (!fs.existsSync(pdfPath)) {
                    throw new Error(`Matching PDF not found: ${pdfPath}`);
                }
                const out = await convertDocViaPdf(pdfPath);
                html = out.html;
                conversionPath = "pdf-parse(.pdf fallback)";
            } else {
                throw new Error(`Unsupported extension: ${c.file}`);
            }
        } catch (err) {
            console.error(`  CONVERT FAIL [${c.name}]:`, err.message);
            conversionResults.push({ name: c.name, type: c.type, isDefault: c.isDefault, htmlBytes: 0, conversionPath: `ERROR: ${err.message}` });
            continue;
        }

        const trimmed = (html || "").trim();
        // Require meaningful content — not just whitespace/empty tags.
        const textOnly = trimmed.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
        if (!textOnly) {
            console.error(`  EMPTY HTML [${c.name}]`);
            conversionResults.push({ name: c.name, type: c.type, isDefault: c.isDefault, htmlBytes: 0, conversionPath: `${conversionPath} (empty)` });
            continue;
        }

        let bodyWithSignatures = trimmed;
        if (!trimmed.includes("SIGNATURE_BLOCK")) {
            bodyWithSignatures += `
<p>&nbsp;</p>
<hr />
<p><strong>CLIENT SIGNATURE</strong></p>
<p>{{SIGNATURE_BLOCK}}</p>
<p>Printed Name: ___________________________________</p>
<p>Date: {{DATE_BLOCK}}</p>
<p>&nbsp;</p>
<hr />
<p><strong>CONTRACTOR SIGNATURE</strong></p>
<p>{{CONTRACTOR_SIGNATURE_BLOCK}}</p>
<p>Company: ___________________________________</p>
<p>Date: ___________________________________</p>
`;
        }

        const bodyWithMergeFields = autoPopulateMergeFields(c.name, bodyWithSignatures);
        rows.push({ name: c.name, type: c.type, body: bodyWithMergeFields, isDefault: c.isDefault });
        conversionResults.push({ name: c.name, type: c.type, isDefault: c.isDefault, htmlBytes: bodyWithMergeFields.length, conversionPath, warnings: warnings.length });
    }

    // Abort if any conversions failed so we don't wipe what's in the DB.
    const failCount = conversionResults.filter(r => r.htmlBytes === 0).length;
    if (failCount > 0) {
        console.error(`\n✗ ${failCount} conversion(s) failed. Aborting — DB unchanged.`);
        console.table(conversionResults);
        process.exit(1);
    }

    // Phase 2: back up then atomically replace all rows.
    console.log("→ Backing up existing DocumentTemplate rows...");
    const existing = await prisma.documentTemplate.findMany();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(__dirname, `.template-backup-${ts}.json`);
    await fsp.writeFile(backupPath, JSON.stringify(existing, null, 2), "utf8");
    console.log(`  backed up ${existing.length} row(s) → ${backupPath}`);

    console.log("→ Writing to DB (atomic transaction)...");
    await prisma.$transaction(async (tx) => {
        await tx.documentTemplate.deleteMany({});
        for (const row of rows) {
            await tx.documentTemplate.create({ data: row });
        }
    });

    console.log("\n→ Import results:");
    console.table(conversionResults);

    const total = await prisma.documentTemplate.count();
    console.log(`\n✓ DocumentTemplate row count: ${total}`);
    console.log(`  Backup file:   ${backupPath}`);
}

main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
