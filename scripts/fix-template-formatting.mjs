// One-off script: fix formatting artifacts in the 12 imported residential remodel templates.
//
// Problems to fix:
//   1. Tab characters (\t) used for Word column alignment — collapse to nothing in HTML
//   2. <h1> on contract body sections makes them enormous — convert to <h2>/<h3>
//   3. <h1> on Change Order field labels — convert to <p>
//   4. <h1> on Disclosure Statement warning paragraphs — convert to <p><strong>
//   5. PARTIES two-column section (tab-separated) — convert to a proper table
//   6. Express Limited Home Warranty (PDF-extracted) — restructure section headers
//
// Run: node scripts/fix-template-formatting.mjs

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// ─── helpers ─────────────────────────────────────────────────────────────────

const PARTIES_TABLE = `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px 0"><tbody>` +
  `<tr><td style="width:50%;padding:3px 12px 3px 0;font-weight:bold">"Owner"</td>` +
  `<td style="width:50%;padding:3px 0 3px 12px;font-weight:bold">"Contractor"</td></tr>` +
  `<tr><td style="padding:3px 12px 3px 0">Name: ________________________</td>` +
  `<td style="padding:3px 0 3px 12px">Name: ________________________</td></tr>` +
  `<tr><td style="padding:3px 12px 3px 0">Address: ________________________</td>` +
  `<td style="padding:3px 0 3px 12px">Address: ________________________</td></tr>` +
  `<tr><td style="padding:3px 12px 3px 0">________________________</td>` +
  `<td style="padding:3px 0 3px 12px">________________________</td></tr>` +
  `<tr><td style="padding:3px 12px 3px 0">Phone No: ________________________</td>` +
  `<td style="padding:3px 0 3px 12px">Phone No: ________________________</td></tr>` +
  `<tr><td style="padding:3px 12px 3px 0">Email: ________________________</td>` +
  `<td style="padding:3px 0 3px 12px">Email: ________________________</td></tr>` +
  `</tbody></table>`;

// Replace tab chars with a non-breaking em-space
function fixTabs(html) {
  return html.replace(/\t/g, '&emsp;');
}

// Replace the tab-based Owner/Contractor parties block with a proper 2-column table.
// Must run BEFORE fixTabs so the raw \t chars are still present.
function fixPartiesTable(html) {
  // Match from the "Owner" / "Contractor" header through the Email line.
  // Allow arbitrary tabs/spaces between columns. The [\s\S]*? spans the 5 lines.
  const re = /<p><strong>["“]Owner["”][\t ]+["“]Contractor["”]<\/strong><\/p>[\s\S]*?<p>[^<]*Email[^<]*<\/p>/;
  return html.replace(re, PARTIES_TABLE);
}

// Contract body: split "<h1>SECTION TITLE. Body text...</h1>" into
// "<h2>SECTION TITLE.</h2><p>Body text...</p>" and plain "<h1>TITLE</h1>" → <h2>
function fixContractH1(html) {
  return html.replace(/<h1>([\s\S]*?)<\/h1>/g, (match, inner) => {
    const trimmed = inner.trim();
    // Detect: starts with ALL-CAPS header ending in ". " followed by lowercase body
    const splitMatch = trimmed.match(/^([A-Z][A-Z\s,./()'""“”\-]+\.)(\s+[\s\S]+)$/);
    if (splitMatch) {
      const header = splitMatch[1].trim();
      const body = splitMatch[2].trim();
      return `<h2>${header}</h2><p>${body}</p>`;
    }
    // No body text — just convert heading level
    return `<h2>${trimmed}</h2>`;
  });
}

// Change Order: first h1 (document title) → h2, all subsequent h1 → plain <p>
function fixChangeOrderH1(html) {
  let count = 0;
  return html.replace(/<h1>([\s\S]*?)<\/h1>/g, (match, inner) => {
    count++;
    if (count === 1) return `<h2>${inner.trim()}</h2>`;
    return `<p>${inner.trim()}</p>`;
  });
}

// Disclosure Statement: every h1 is a warning paragraph in all-caps — convert to bold <p>
function fixDisclosureH1(html) {
  return html.replace(/<h1>([\s\S]*?)<\/h1>/g, (match, inner) => {
    return `<p><strong>${inner.trim()}</strong></p>`;
  });
}

// Express Warranty (PDF-extracted): one big <p> with <br/> line breaks.
// Detect ALL-CAPS section header lines and convert to <h2>. Rebuild as proper <p> blocks.
function fixWarrantyPdf(html) {
  // Strip leading "Page | N" noise lines that PDF footers inject
  html = html.replace(/<br\/>[\s]*EXPRESS LIMITED WARRANTY AGREEMENT[\s]*\t+Page \| \d+<br\/>/g, '');
  html = html.replace(/EXPRESS LIMITED WARRANTY AGREEMENT[\s]*\t+Page \| \d+<br\/>/g, '');

  // Known section header strings in this document
  const SECTION_HEADERS = [
    'EXPRESS LIMITED WARRANTY AGREEMENT',
    'SCOPE OF WARRANTY',
    "OWNER'S ACKNOWLEDGMENT OF ASSIGNMENT OF MANUFACTURER'S",
    'WARRANTIES',
    "CONTRACTOR'S DUTIES",
    "OWNER'S DUTIES",
    'EXCLUSIONS',
    'DISPUTE RESOLUTION',
    'GENERAL PROVISIONS',
    'SIGNATURES',
    'OWNER:',
    'CONTRACTOR:',
  ];

  // Split on <br/> and rebuild
  const lines = html
    .replace(/<\/?p>/g, '')
    .split(/<br\/>/)
    .map(l => l.replace(/\t/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  const parts = [];
  let buffer = [];

  function flushBuffer() {
    if (buffer.length) {
      parts.push(`<p>${buffer.join(' ')}</p>`);
      buffer = [];
    }
  }

  for (const line of lines) {
    const isHeader = SECTION_HEADERS.some(h => line.startsWith(h)) ||
      /^[A-Z][A-Z\s',./()&-]{8,}$/.test(line);
    if (isHeader) {
      flushBuffer();
      parts.push(`<h2>${line}</h2>`);
    } else {
      buffer.push(line);
    }
  }
  flushBuffer();

  return parts.join('\n');
}

// ─── per-template fix map ─────────────────────────────────────────────────────

function fixTemplate(name, type, body) {
  const lower = name.toLowerCase();

  // Lump Sum + Cost Plus contracts
  if (lower.includes('lump sum') || lower.includes('cost plus')) {
    let b = fixPartiesTable(body);     // parties table (before tab fix)
    b = fixContractH1(b);              // h1 section headers → h2 (with body split)
    b = fixTabs(b);
    return b;
  }

  // Special Provisions Addendum (also has PARTIES block but no h1 body sections)
  if (lower.includes('special provisions')) {
    let b = fixPartiesTable(body);
    b = fixTabs(b);
    return b;
  }

  // Change Order Form
  if (lower.includes('change order')) {
    let b = fixChangeOrderH1(body);
    b = fixTabs(b);
    return b;
  }

  // Disclosure Statement
  if (lower.includes('disclosure')) {
    let b = fixDisclosureH1(body);
    b = fixTabs(b);
    return b;
  }

  // Express Limited Home Warranty (PDF-extracted, needs full restructure)
  if (lower.includes('express limited')) {
    return fixWarrantyPdf(body);
  }

  // All other templates: just fix tabs
  return fixTabs(body);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const templates = await prisma.documentTemplate.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, type: true, body: true },
  });

  console.log(`Processing ${templates.length} templates...\n`);
  const results = [];

  for (const t of templates) {
    const fixed = fixTemplate(t.name, t.type, t.body);
    const changed = fixed !== t.body;

    if (changed) {
      await prisma.documentTemplate.update({
        where: { id: t.id },
        data: { body: fixed },
      });
    }

    results.push({
      name: t.name,
      changed,
      before: t.body.length,
      after: fixed.length,
    });
  }

  console.table(results);
  console.log('\n✓ Done.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
