/**
 * import-houzz.mjs — Import Houzz Pro CSV export into ProBuild
 *
 * Usage:
 *   node scripts/import-houzz.mjs "path/to/houzz-export.csv"
 *   node scripts/import-houzz.mjs --dry-run "path/to/houzz-export.csv"
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'fs';

const DRY_RUN = process.argv.includes('--dry-run');
const CSV_PATH = process.argv.filter(a => !a.startsWith('--') && !a.endsWith('node') && !a.endsWith('import-houzz.mjs')).pop();

if (!CSV_PATH) {
  console.error('Usage: node scripts/import-houzz.mjs [--dry-run] <csv-path>');
  process.exit(1);
}

const prisma = new PrismaClient();

// ── Lookup maps (populated during import) ───────────────────────────────────
const clientNameToId = new Map();   // normalized name → ProBuild client ID
const vendorNameToId = new Map();   // normalized name → ProBuild vendor ID
const leadKeyToId = new Map();      // "clientName|leadName" → ProBuild lead ID
const projectNameToId = new Map();  // normalized name → ProBuild project ID
const docNumberToId = new Map();    // houzz doc number → { type, id }
const projectNameToClientId = new Map(); // project name → clientId (for invoices)

// ── Stats ───��─────────────────────────���─────────────────────────────────────
const stats = {
  clients:   { created: 0, skipped: 0, updated: 0, errors: [] },
  vendors:   { created: 0, skipped: 0, errors: [] },
  leads:     { created: 0, skipped: 0, filtered: 0, errors: [] },
  projects:  { created: 0, skipped: 0, errors: [] },
  estimates: { created: 0, skipped: 0, errors: [] },
  items:     { created: 0, skipped: 0, errors: [] },
  invoices:  { created: 0, skipped: 0, errors: [] },
  contracts: { created: 0, skipped: 0, errors: [] },
  milestones:{ created: 0, skipped: 0, errors: [] },
  notes:     { created: 0, skipped: 0, errors: [] },
  products:  { created: 0, skipped: 0, errors: [] },
};

// ── Utilities ──────────────���─────────────────────────��──────────────────────
function normalize(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function makeInitials(name) {
  return (name || '')
    .split(' ')
    .map(n => n[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
    .slice(0, 2) || '??';
}

function parseDate(str) {
  if (!str || str.trim() === '') return null;
  // Handle "Mon DD, YYYY" format like "Jan 24, 2026"
  // Append noon local time so UTC conversion doesn't shift the calendar day.
  const trimmed = str.trim();
  // If string already contains time info (T separator, or a space-delimited HH:MM), use as-is.
  // Otherwise append noon local so UTC conversion doesn't shift the calendar day.
  const hasTime = /T\d{2}:|\s\d{2}:\d{2}/.test(trimmed);
  const d = hasTime ? new Date(trimmed) : new Date(`${trimmed} 12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

function parseMoney(str) {
  if (!str || str.trim() === '') return 0;
  const n = parseFloat(str.replace(/[,$]/g, ''));
  if (isNaN(n)) return 0;
  // Clamp negatives to 0 — Houzz exports occasionally contain "-$X" refund rows
  // that would otherwise write negative totals to the DB. Warn so the caller
  // can audit the run log and catch legitimate refund data being swallowed.
  if (n < 0) {
    console.warn(`[parseMoney] Negative value "${str}" clamped to 0`);
    return 0;
  }
  return n;
}

function isDefaultClient(name, email) {
  const n = normalize(name);
  const e = (email || '').trim().toLowerCase();
  return (n === 'default client' || n === '' || n === ' ') &&
    (e === 'no_email@houzz.com' || e === 'sampleclient@houzz.com' || e === '');
}

function isTestProject(name) {
  const n = normalize(name);
  return n === 'test' || n === 'sample project from houzz';
}

function normalizeState(state) {
  // Houzz uses full state names; ProBuild uses abbreviations or full — keep as-is
  return (state || '').trim();
}

// ── Multi-Section CSV Parser ────���───────────────────────────────────────────
const KNOWN_SECTIONS = new Set([
  'COMPANY', 'TEAM_MEMBERS', 'ADDRESSES', 'CLIENTS', 'PRODUCTS',
  'CUSTOM_FIELDS', 'TIME_TRACKS', 'EXPENSES', 'SALES_TAXES',
  'PROJECTS', 'ROOM_BOARDS', 'SERVICES', 'VENDORS', 'DOCUMENTS',
  'DOCUMENT_ITEMS', 'MILESTONES', 'ATTACHMENTS', 'CATEGORIES',
  'PARTS', 'TASKS', 'TEMPLATES', 'INQUIRIES', 'TAGS', 'NOTES',
  'MOOD_BOARD_ATTACHMENTS', 'SECTIONS', 'DAILY_LOG_SECTIONS',
  'VIDEOS', 'VENDOR', 'CATALOG_ITEMS', 'SIGNATURES', 'FILES',
]);

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseSections(content) {
  const lines = content.split('\n');
  const sections = {};
  let currentSection = null;
  let headers = null;
  let pendingHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const trimmed = raw.trim();

    // Skip blank lines and " " spacer lines
    if (trimmed === '' || trimmed === '" "' || trimmed === '""') {
      continue;
    }

    // Check if this line is a section header
    const maybeSectionName = trimmed.replace(/^"|"$/g, '');
    if (KNOWN_SECTIONS.has(maybeSectionName)) {
      currentSection = maybeSectionName;
      sections[currentSection] = { headers: [], rows: [] };
      pendingHeader = true;
      continue;
    }

    if (!currentSection) continue;

    if (pendingHeader) {
      // This line is the column header row
      sections[currentSection].headers = parseCSVLine(raw);
      pendingHeader = false;
      continue;
    }

    // Handle multi-line quoted fields: if the line has an odd number of unescaped
    // quotes, keep concatenating lines until balanced
    let fullLine = raw;
    let quoteCount = (fullLine.match(/"/g) || []).length;
    while (quoteCount % 2 !== 0 && i + 1 < lines.length) {
      i++;
      fullLine += '\n' + lines[i].replace(/\r$/, '');
      quoteCount = (fullLine.match(/"/g) || []).length;
    }

    const fields = parseCSVLine(fullLine);
    // Skip rows that are clearly separators or section transitions
    if (fields.length <= 1 && (fields[0] || '').trim() === '') continue;

    sections[currentSection].rows.push(fields);
  }

  return sections;
}

function rowToObj(headers, fields) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = (fields[i] || '').trim();
  }
  return obj;
}

// ── Import: Clients ─────────���───────────────────────────────────────────────
async function importClients(section) {
  if (!section) { console.log('[Clients] Section not found — skipping'); return; }
  console.log(`[Clients] Processing ${section.rows.length} rows...`);

  // First pass: deduplicate by normalized name, keeping the most complete record
  const bestRecord = new Map();
  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    if (isDefaultClient(row.NAME, row.EMAIL)) continue;
    if (!row.NAME || row.NAME.trim() === '') continue;

    const key = normalize(row.NAME);
    const existing = bestRecord.get(key);
    if (!existing) {
      bestRecord.set(key, row);
    } else {
      // Merge: prefer whichever record has more filled-in fields
      const scoreA = [existing.EMAIL, existing.PHONE, existing.ADDRESS, existing.CITY].filter(Boolean).length;
      const scoreB = [row.EMAIL, row.PHONE, row.ADDRESS, row.CITY].filter(Boolean).length;
      if (scoreB > scoreA) {
        // Keep new row but merge in missing fields from existing
        for (const [k, v] of Object.entries(existing)) {
          if (v && !row[k]) row[k] = v;
        }
        bestRecord.set(key, row);
      } else {
        // Keep existing but merge in missing fields from new row
        for (const [k, v] of Object.entries(row)) {
          if (v && !existing[k]) existing[k] = v;
        }
      }
    }
  }

  for (const [key, row] of bestRecord) {
    try {
      const name = row.NAME.trim();
      const email = row.EMAIL && row.EMAIL !== 'no_email@houzz.com' ? row.EMAIL : null;

      // Check DB for existing client
      const existing = await prisma.client.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
      });

      if (existing) {
        clientNameToId.set(key, existing.id);
        // Fill in missing fields
        const updates = {};
        if (!existing.email && email) updates.email = email;
        if (!existing.primaryPhone && row.PHONE) updates.primaryPhone = row.PHONE;
        if (!existing.additionalEmail && row.SECOND_EMAIL) updates.additionalEmail = row.SECOND_EMAIL;
        if (!existing.additionalPhone && row.SECOND_PHONE) updates.additionalPhone = row.SECOND_PHONE;
        if (!existing.companyName && row.COMPANY_NAME) updates.companyName = row.COMPANY_NAME;
        if (!existing.addressLine1 && row.ADDRESS) updates.addressLine1 = row.ADDRESS;
        if (!existing.addressLine2 && row.ADDRESS2) updates.addressLine2 = row.ADDRESS2;
        if (!existing.city && row.CITY) updates.city = row.CITY;
        if (!existing.state && row.STATE) updates.state = normalizeState(row.STATE);
        if (!existing.zipCode && row.ZIP) updates.zipCode = row.ZIP;
        if (!existing.internalNotes && row.NOTES) updates.internalNotes = row.NOTES;

        if (Object.keys(updates).length > 0 && !DRY_RUN) {
          await prisma.client.update({ where: { id: existing.id }, data: updates });
          stats.clients.updated++;
        } else {
          stats.clients.skipped++;
        }
        continue;
      }

      if (!DRY_RUN) {
        const client = await prisma.client.create({
          data: {
            name,
            initials: makeInitials(name),
            email: email || null,
            companyName: row.COMPANY_NAME || null,
            primaryPhone: row.PHONE || null,
            additionalEmail: row.SECOND_EMAIL || null,
            additionalPhone: row.SECOND_PHONE || null,
            addressLine1: row.ADDRESS || null,
            addressLine2: row.ADDRESS2 || null,
            city: row.CITY || null,
            state: normalizeState(row.STATE) || null,
            zipCode: row.ZIP || null,
            internalNotes: row.NOTES || null,
          },
        });
        clientNameToId.set(key, client.id);
      }
      stats.clients.created++;
    } catch (err) {
      stats.clients.errors.push({ name: row.NAME, error: err.message });
    }
  }

  console.log(`[Clients] Created ${stats.clients.created}, Updated ${stats.clients.updated}, Skipped ${stats.clients.skipped}, Errors ${stats.clients.errors.length}`);
}

// ── Import: Vendors ────────���──────────────────��──────────────────────��──────
async function importVendors(section) {
  if (!section) { console.log('[Vendors] Section not found — skipping'); return; }
  console.log(`[Vendors] Processing ${section.rows.length} rows...`);

  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const name = (row.COMPANY_NAME || '').trim();
    if (!name || name === 'Default vendor' || normalize(name) === 'default vendor') continue;
    if (row.IS_ARCHIVED === 'yes') continue; // skip archived sample vendors

    const key = normalize(name);
    try {
      const existing = await prisma.vendor.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
      });

      if (existing) {
        vendorNameToId.set(key, existing.id);
        stats.vendors.skipped++;
        continue;
      }

      if (!DRY_RUN) {
        const email = row.EMAIL && row.EMAIL !== 'default_vendor@houzz.com' ? row.EMAIL : null;
        const vendor = await prisma.vendor.create({
          data: {
            name,
            firstName: row.FIRST_NAME || null,
            lastName: row.LAST_NAME || null,
            email: email || null,
            phone: row.PHONE_NUMBER || null,
            website: row.WEBSITE || null,
            address1: row.ADDRESS || null,
            address2: row.ADDRESS2 || null,
            city: row.CITY || null,
            state: normalizeState(row.STATE) || null,
            zipCode: row.ZIP || null,
            notes: row.NOTES || null,
            description: row.DESCRIPTION || null,
            status: 'ACTIVE',
          },
        });
        vendorNameToId.set(key, vendor.id);
      }
      stats.vendors.created++;
    } catch (err) {
      stats.vendors.errors.push({ name, error: err.message });
    }
  }

  console.log(`[Vendors] Created ${stats.vendors.created}, Skipped ${stats.vendors.skipped}, Errors ${stats.vendors.errors.length}`);
}

// ── Helper: Find or create client by name ───────────────────────────────────
async function findOrCreateClient(name, extraData = {}) {
  if (!name || isDefaultClient(name, '')) return null;
  const key = normalize(name);

  if (clientNameToId.has(key)) return clientNameToId.get(key);

  const existing = await prisma.client.findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' } },
  });
  if (existing) {
    clientNameToId.set(key, existing.id);
    return existing.id;
  }

  if (DRY_RUN) {
    const fakeId = `dry-run-${key}`;
    clientNameToId.set(key, fakeId);
    return fakeId;
  }

  const client = await prisma.client.create({
    data: {
      name: name.trim(),
      initials: makeInitials(name),
      email: extraData.email || null,
      primaryPhone: extraData.phone || null,
      addressLine1: extraData.address || null,
      city: extraData.city || null,
      state: normalizeState(extraData.state) || null,
      zipCode: extraData.zip || null,
    },
  });
  clientNameToId.set(key, client.id);
  stats.clients.created++;
  return client.id;
}

// ── Import: Leads (from INQUIRIES) ───────────────���──────────────────────────
async function importLeads(section) {
  if (!section) { console.log('[Leads] Section not found — skipping'); return; }
  console.log(`[Leads] Processing ${section.rows.length} rows...`);

  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const clientName = (row.CLIENT_NAME || '').trim();
    const leadName = (row.NAME || clientName || '').trim();

    if (!leadName) continue;

    // Filter spam
    const statusReason = (row.STATUS_REASON || '').toLowerCase();
    if (row.STATUS === 'Archived' && (statusReason.includes('spam') || statusReason.includes('flagged'))) {
      stats.leads.filtered++;
      continue;
    }

    // Skip test/sample leads
    if (normalize(leadName) === 'sample lead from houzz') {
      stats.leads.filtered++;
      continue;
    }

    try {
      const clientId = await findOrCreateClient(clientName, {
        address: row.ADDRESS,
      });
      if (!clientId) {
        stats.leads.filtered++;
        continue;
      }

      // Map stage
      let stage = 'New';
      let isArchived = false;
      if (row.STATUS === 'Won') stage = 'Won';
      else if (row.STATUS === 'Archived') { stage = 'Closed'; isArchived = true; }
      else if (row.STATUS === 'Current') stage = 'New';

      // Dedup: check for existing lead with same name + clientId
      const leadKey = `${normalize(clientName)}|${normalize(leadName)}`;
      if (!DRY_RUN) {
        const existing = await prisma.lead.findFirst({
          where: { clientId, name: { equals: leadName, mode: 'insensitive' } },
        });
        if (existing) {
          leadKeyToId.set(leadKey, existing.id);
          stats.leads.skipped++;
          continue;
        }

        // Parse the description / GENERAL_NOTES for the initial message
        let message = row.DESCRIPTION || null;
        // GENERAL_NOTES often has JSON-encoded question/answer pairs
        if (!message && row.GENERAL_NOTES) {
          try {
            const notes = JSON.parse(row.GENERAL_NOTES);
            if (Array.isArray(notes)) {
              const msgEntry = notes.find(n => n.projectQuestion === 'Message');
              if (msgEntry) message = msgEntry.projectAnswer;
            }
          } catch { /* not JSON, use raw */ message = row.GENERAL_NOTES; }
        }

        // Parse location from GENERAL_NOTES if available
        let location = row.ADDRESS || null;
        if (!location && row.GENERAL_NOTES) {
          try {
            const notes = JSON.parse(row.GENERAL_NOTES);
            if (Array.isArray(notes)) {
              const locEntry = notes.find(n => n.projectQuestion === 'Project Location');
              if (locEntry && locEntry.projectAnswer !== 'N/A') location = locEntry.projectAnswer;
            }
          } catch { /* ignore */ }
        }

        const lead = await prisma.lead.create({
          data: {
            name: leadName,
            clientId,
            stage,
            source: 'Houzz',
            projectType: row.SERVICE_TYPE || null,
            location,
            targetRevenue: parseMoney(row.REVENUE) || null,
            expectedStartDate: parseDate(row.EXPECTED_START_DATE),
            createdAt: parseDate(row.CREATED_AT) || new Date(),
            isArchived,
            message,
            lastActivityAt: parseDate(row.LAST_CONTACT) || parseDate(row.CREATED_AT) || new Date(),
          },
        });
        leadKeyToId.set(leadKey, lead.id);
      }
      stats.leads.created++;
    } catch (err) {
      stats.leads.errors.push({ name: leadName, error: err.message });
    }
  }

  console.log(`[Leads] Created ${stats.leads.created}, Skipped ${stats.leads.skipped}, Filtered ${stats.leads.filtered}, Errors ${stats.leads.errors.length}`);
}

// ── Import: Projects ────────────────────────────────────────────────────────
async function importProjects(section) {
  if (!section) { console.log('[Projects] Section not found — skipping'); return; }
  console.log(`[Projects] Processing ${section.rows.length} rows...`);

  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const projectName = (row.PROJECT_NAME || '').trim();
    if (!projectName) continue;
    if (isTestProject(projectName)) { stats.projects.skipped++; continue; }

    // Resolve client — prefer CLIENT_NAME column, fallback to embedded email
    let clientName = (row.CLIENT_NAME || '').trim();
    const clientEmail = (row.EMAIL || '').trim();
    const clientPhone = (row.PHONE_NUMBER || '').trim();

    // If client is "Default Client", try to derive from project data
    if (isDefaultClient(clientName, clientEmail)) {
      // Use project name as a last resort client name
      clientName = projectName;
    }

    try {
      const clientId = await findOrCreateClient(clientName, {
        email: clientEmail !== 'no_email@houzz.com' ? clientEmail : null,
        phone: clientPhone,
        address: row.ADDRESS,
        city: row.CITY,
        state: row.STATE,
        zip: row.ZIP,
      });
      if (!clientId) { stats.projects.skipped++; continue; }

      const key = normalize(projectName);
      projectNameToClientId.set(key, clientId);

      // Dedup: check for existing project with same name + clientId
      if (!DRY_RUN) {
        const existing = await prisma.project.findFirst({
          where: { name: { equals: projectName, mode: 'insensitive' }, clientId },
        });
        if (existing) {
          projectNameToId.set(key, existing.id);
          stats.projects.skipped++;
          continue;
        }

        // Check if there's a matching Won lead to link
        let leadId = null;
        const leadKey = `${normalize(clientName)}|${normalize(projectName)}`;
        if (leadKeyToId.has(leadKey)) {
          const candidateLeadId = leadKeyToId.get(leadKey);
          // Verify the lead isn't already linked to another project
          const linkedProject = await prisma.project.findUnique({ where: { leadId: candidateLeadId } });
          if (!linkedProject) leadId = candidateLeadId;
        }

        const isArchived = row.IS_ARCHIVED === 'yes';
        const location = [row.ADDRESS, row.CITY, row.STATE, row.ZIP].filter(Boolean).join(', ') || null;

        const project = await prisma.project.create({
          data: {
            name: projectName,
            clientId,
            leadId,
            location,
            status: isArchived ? 'Closed' : 'In Progress',
            type: row.PROJECT_TYPE_NAME || null,
            tags: row.TAX_NAME || null, // TAX_NAME often has the region tag
            createdAt: parseDate(row.CREATED_AT) || new Date(),
            viewedAt: parseDate(row.LAST_UPDATED) || new Date(),
          },
        });
        projectNameToId.set(key, project.id);

        // If we linked a lead, mark it as Won
        if (leadId) {
          await prisma.lead.update({ where: { id: leadId }, data: { stage: 'Won' } });
        }
      } else {
        projectNameToId.set(key, `dry-run-${key}`);
      }
      stats.projects.created++;
    } catch (err) {
      stats.projects.errors.push({ name: projectName, error: err.message });
    }
  }

  console.log(`[Projects] Created ${stats.projects.created}, Skipped ${stats.projects.skipped}, Errors ${stats.projects.errors.length}`);
}

// ── Import: Documents (Estimates, Invoices, Contracts) ──────────────────────
async function importDocuments(section) {
  if (!section) { console.log('[Documents] Section not found — skipping'); return; }
  console.log(`[Documents] Processing ${section.rows.length} rows...`);

  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const docNum = (row.DOCUMENT_NUMBER || '').trim();
    const docType = (row.TYPE || '').trim();
    const projectName = (row.PROJECT_NAME || '').trim();
    const docName = (row.NAME || '').trim();

    if (!docNum || !docType) continue;

    // Skip removed/voided documents
    if (row.REMOVED_DATE && row.REMOVED_DATE.trim()) continue;
    if (row.VOIDED_AT && row.VOIDED_AT.trim()) continue;

    const projectKey = normalize(projectName);
    const projectId = projectNameToId.get(projectKey) || null;

    if (docType === 'Estimate') {
      await importEstimate(row, docNum, docName, projectId, projectKey);
    } else if (docType === 'Invoice') {
      await importInvoice(row, docNum, docName, projectId, projectKey);
    } else if (docType === 'Contract') {
      await importContract(row, docNum, docName, projectId, projectKey);
    }
    // PurchaseDocument and Retainer are P3 — skip for now
  }
}

async function importEstimate(row, docNum, docName, projectId, projectKey) {
  try {
    if (!projectId) {
      stats.estimates.skipped++;
      return;
    }

    // Dedup by checking if an estimate with this title already exists for the project
    if (!DRY_RUN) {
      const existing = await prisma.estimate.findFirst({
        where: { projectId, title: { equals: docName || 'Imported Estimate', mode: 'insensitive' } },
      });
      if (existing) {
        docNumberToId.set(docNum, { type: 'estimate', id: existing.id });
        stats.estimates.skipped++;
        return;
      }

      // Map status
      let status = 'Draft';
      const houzzStatus = (row.STATUS || '').trim();
      if (houzzStatus === 'Sent') status = 'Sent';
      else if (houzzStatus === 'Approved') status = 'Approved';
      else if (houzzStatus === 'PartiallyInvoiced' || houzzStatus === 'Invoiced') status = 'Sent';
      else if (houzzStatus === 'Paid') status = 'Sent';

      const totalAmount = parseMoney(row.TOTAL_PAYMENT);
      const totalPaid = parseMoney(row.TOTAL_PAID);
      const balanceDue = totalAmount - totalPaid;

      const estimate = await prisma.estimate.create({
        data: {
          title: docName || 'Imported Estimate',
          projectId,
          code: 'EST-TEMP',
          status,
          totalAmount,
          balanceDue: balanceDue > 0 ? balanceDue : 0,
          privacy: 'Shared',
          termsAndConditions: row.T_AND_C_TEXT || null,
          memo: row.NOTES || null,
          sentAt: parseDate(row.SENT_DATE),
          approvedAt: parseDate(row.APPROVED_AT),
          createdAt: parseDate(row.CREATED_AT) || new Date(),
        },
      });

      // Update code with the DB-assigned autoincrement number
      const code = `EST-${String(estimate.number).padStart(5, '0')}`;
      await prisma.estimate.update({ where: { id: estimate.id }, data: { code } });

      docNumberToId.set(docNum, { type: 'estimate', id: estimate.id });
    } else {
      docNumberToId.set(docNum, { type: 'estimate', id: `dry-run-est-${docNum}` });
    }
    stats.estimates.created++;
  } catch (err) {
    stats.estimates.errors.push({ docNum, name: docName, error: err.message });
  }
}

async function importInvoice(row, docNum, docName, projectId, projectKey) {
  try {
    if (!projectId) { stats.invoices.skipped++; return; }

    const clientId = projectNameToClientId.get(projectKey);
    if (!clientId) { stats.invoices.skipped++; return; }

    if (!DRY_RUN) {
      // Map status
      let status = 'Draft';
      const houzzStatus = (row.STATUS || '').trim();
      if (houzzStatus === 'Sent') status = 'Issued';
      else if (houzzStatus === 'Paid') status = 'Paid';
      else if (houzzStatus === 'Overdue') status = 'Overdue';
      else if (houzzStatus === 'PartiallyPaid') status = 'Issued';

      const totalAmount = parseMoney(row.TOTAL_PAYMENT);
      const totalPaid = parseMoney(row.TOTAL_PAID);
      const invoiceCreatedAt = parseDate(row.CREATED_AT) || new Date();
      const houzzMarker = `[Houzz #${docNum}]`;

      // Dedup strong path: match on the Houzz document number embedded in notes.
      let existingInvoice = await prisma.invoice.findFirst({
        where: { projectId, notes: { startsWith: houzzMarker } },
      });
      // Dedup fallback: any row in this project with the same total is treated
      // as the match (covers legacy pre-marker rows and CSV rows with repeated
      // totals). If the legacy row is unmarked, backfill the marker so the
      // next run uses the strong path.
      if (!existingInvoice) {
        const legacy = await prisma.invoice.findFirst({ where: { projectId, totalAmount } });
        if (legacy) {
          if (!(legacy.notes || '').startsWith('[Houzz #')) {
            const newNotes = `${houzzMarker} ${legacy.notes || ''}`.trim();
            await prisma.invoice.update({ where: { id: legacy.id }, data: { notes: newNotes } });
          }
          existingInvoice = legacy;
        }
      }
      if (existingInvoice) {
        docNumberToId.set(docNum, { type: 'invoice', id: existingInvoice.id });
        stats.invoices.skipped++;
        return;
      }

      const notesField = row.NOTES ? `${houzzMarker} ${row.NOTES}` : houzzMarker;

      const invoice = await prisma.invoice.create({
        data: {
          projectId,
          clientId,
          code: 'INV-TEMP',
          status,
          totalAmount,
          balanceDue: totalAmount - totalPaid > 0 ? totalAmount - totalPaid : 0,
          notes: notesField,
          issueDate: parseDate(row.ISSUED_AT) || parseDate(row.CREATED_AT),
          sentAt: parseDate(row.SENT_DATE),
          createdAt: invoiceCreatedAt,
        },
      });

      const invoiceCode = `INV-${String(invoice.number).padStart(5, '0')}`;
      await prisma.invoice.update({ where: { id: invoice.id }, data: { code: invoiceCode } });

      docNumberToId.set(docNum, { type: 'invoice', id: invoice.id });
    }
    stats.invoices.created++;
  } catch (err) {
    stats.invoices.errors.push({ docNum, name: docName, error: err.message });
  }
}

async function importContract(row, docNum, docName, projectId, projectKey) {
  try {
    if (!projectId) { stats.contracts.skipped++; return; }

    if (!DRY_RUN) {
      const title = docName || 'Imported Contract';
      const houzzMarker = `<!-- [Houzz #${docNum}] -->`;

      // Dedup strong path: marker in body.
      let existing = await prisma.contract.findFirst({
        where: { projectId, body: { startsWith: houzzMarker } },
      });
      // Fallback on (projectId, title) covers legacy rows and repeated titles.
      // Self-heal the marker only when the legacy row is unmarked.
      if (!existing) {
        const legacy = await prisma.contract.findFirst({
          where: { projectId, title: { equals: title, mode: 'insensitive' } },
        });
        if (legacy) {
          if (!(legacy.body || '').startsWith('<!-- [Houzz #')) {
            await prisma.contract.update({
              where: { id: legacy.id },
              data: { body: `${houzzMarker}${legacy.body || ''}` },
            });
          }
          existing = legacy;
        }
      }
      if (existing) {
        docNumberToId.set(docNum, { type: 'contract', id: existing.id });
        stats.contracts.skipped++;
        return;
      }

      let status = 'Draft';
      const houzzStatus = (row.STATUS || '').trim();
      if (houzzStatus === 'Sent') status = 'Sent';
      else if (houzzStatus === 'Signed' || houzzStatus === 'Approved') status = 'Signed';

      const body = `${houzzMarker}${row.T_AND_C_TEXT || '<p>Imported from Houzz Pro</p>'}`;

      const contract = await prisma.contract.create({
        data: {
          title,
          projectId,
          body,
          status,
          sentAt: parseDate(row.SENT_DATE),
          approvedAt: parseDate(row.APPROVED_AT),
          createdAt: parseDate(row.CREATED_AT) || new Date(),
        },
      });

      docNumberToId.set(docNum, { type: 'contract', id: contract.id });
    }
    stats.contracts.created++;
  } catch (err) {
    stats.contracts.errors.push({ docNum, name: docName, error: err.message });
  }
}

// ── Import: Document Items → EstimateItem ────────��──────────────────────────
async function importDocumentItems(section) {
  if (!section) { console.log('[Items] Section not found — skipping'); return; }
  console.log(`[Items] Processing ${section.rows.length} rows...`);

  // Group items by document number
  const byDoc = new Map();
  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const docNum = (row.DOCUMENT_NUMBER || '').trim();
    if (!docNum) continue;
    if (!byDoc.has(docNum)) byDoc.set(docNum, []);
    byDoc.get(docNum).push(row);
  }

  for (const [docNum, items] of byDoc) {
    const docRef = docNumberToId.get(docNum);
    if (!docRef || docRef.type !== 'estimate') continue; // only import estimate items

    const estimateId = docRef.id;
    if (DRY_RUN) {
      stats.items.created += items.length;
      continue;
    }

    // Check if items already exist for this estimate
    const existingCount = await prisma.estimateItem.count({ where: { estimateId } });
    if (existingCount > 0) {
      stats.items.skipped += items.length;
      continue;
    }

    let order = 0;
    for (const row of items) {
      try {
        const name = (row.NAME || '').trim();
        if (!name) continue;

        // Determine type from the COST (which is actually the cost type column name)
        let type = 'Material';
        const costType = (row.COST || '').trim();
        if (costType === 'Labor') type = 'Labor';
        else if (costType === 'MaterialAndLabor') type = 'Material';
        else if (costType === 'Service') type = 'Labor';

        const materialCost = parseMoney(row.MATERIAL_COST);
        const laborCost = parseMoney(row.LABOR_COST);
        const totalPayment = parseMoney(row.TOTAL_PAYMENT);
        const quantity = parseFloat(row.QUANTITY) || 1;

        // unitCost: for Material type, use material cost; for Labor, use labor cost
        let unitCost = 0;
        if (type === 'Labor') {
          unitCost = quantity > 0 ? laborCost / quantity : laborCost;
        } else {
          unitCost = quantity > 0 ? materialCost / quantity : materialCost;
        }

        // If the item has both material and labor costs, the total covers both
        // Use the total per quantity as the unitCost in that case
        if (materialCost > 0 && laborCost > 0) {
          unitCost = quantity > 0 ? totalPayment / quantity : totalPayment;
        }

        await prisma.estimateItem.create({
          data: {
            estimateId,
            name,
            description: row.INFO || null,
            type,
            quantity,
            unitCost,
            total: totalPayment,
            order: order++,
            baseCost: materialCost > 0 ? (quantity > 0 ? materialCost / quantity : materialCost) : null,
            markupPercent: parseMoney(row.PROFIT_PERCENTAGE) || 0,
          },
        });
        stats.items.created++;
      } catch (err) {
        stats.items.errors.push({ docNum, name: row.NAME, error: err.message });
      }
    }

    // Update estimate totals based on actual items
    try {
      const itemsSum = await prisma.estimateItem.aggregate({
        where: { estimateId },
        _sum: { total: true },
      });
      const total = Number(itemsSum._sum.total || 0);
      await prisma.estimate.update({
        where: { id: estimateId },
        data: { totalAmount: total, balanceDue: total },
      });
    } catch { /* non-critical */ }
  }

  console.log(`[Items] Created ${stats.items.created}, Skipped ${stats.items.skipped}, Errors ${stats.items.errors.length}`);
}

// ── Import: Milestones → ScheduleTask ─────────���─────────────────────────────
async function importMilestones(section) {
  if (!section) { console.log('[Milestones] Section not found — skipping'); return; }
  console.log(`[Milestones] Processing ${section.rows.length} rows...`);

  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const name = (row.NAME || '').trim();
    const projectName = (row.PROJECT_NAME || '').trim();
    if (!name || !projectName) continue;

    const projectId = projectNameToId.get(normalize(projectName));
    if (!projectId) { stats.milestones.skipped++; continue; }

    const startDate = parseDate(row.START_DATE);
    const endDate = parseDate(row.DUE_DATE);
    if (!startDate) { stats.milestones.skipped++; continue; } // milestones without dates are useless

    try {
      if (!DRY_RUN) {
        const existing = await prisma.scheduleTask.findFirst({
          where: { projectId, name: { equals: name, mode: 'insensitive' } },
        });
        if (existing) { stats.milestones.skipped++; continue; }

        await prisma.scheduleTask.create({
          data: {
            name,
            projectId,
            startDate,
            endDate: endDate || startDate,
            color: row.COLOR || '#4c9a2a',
            status: 'Not Started',
            type: 'task',
          },
        });
      }
      stats.milestones.created++;
    } catch (err) {
      stats.milestones.errors.push({ name, project: projectName, error: err.message });
    }
  }

  console.log(`[Milestones] Created ${stats.milestones.created}, Skipped ${stats.milestones.skipped}, Errors ${stats.milestones.errors.length}`);
}

// ── Import: Notes → LeadNote ───────────────���────────────────────────────────
// The NOTES section doesn't link to specific leads/projects by ID — only by
// CONTAINER_TYPE ("Inquiry" or "Project"). Without a direct FK we can't reliably
// attach them, so we skip this section for now and log the count.
async function importNotes(section) {
  if (!section) { console.log('[Notes] Section not found — skipping'); return; }
  const inquiryNotes = section.rows.filter(f => {
    const row = rowToObj(section.headers, f);
    return row.CONTAINER_TYPE === 'Inquiry';
  });
  const projectNotes = section.rows.filter(f => {
    const row = rowToObj(section.headers, f);
    return row.CONTAINER_TYPE === 'Project';
  });
  console.log(`[Notes] Found ${inquiryNotes.length} inquiry notes, ${projectNotes.length} project notes — skipped (no direct FK in export)`);
  stats.notes.skipped = section.rows.length;
}

// ── Import: Products → CatalogItem ──────────��─────────────────────────────��─
async function importProducts(section) {
  if (!section) { console.log('[Products] Section not found — skipping'); return; }
  console.log(`[Products] Processing ${section.rows.length} rows...`);

  for (const fields of section.rows) {
    const row = rowToObj(section.headers, fields);
    const name = (row.TITLE || '').trim();
    if (!name) continue;
    if (row.IS_ARCHIVED === 'yes') continue;

    try {
      if (!DRY_RUN) {
        const existing = await prisma.catalogItem.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } },
        });
        if (existing) { stats.products.skipped++; continue; }

        await prisma.catalogItem.create({
          data: {
            name,
            description: row.DESCRIPTION || null,
            unitCost: parseMoney(row.PRICE) || 0,
            unit: 'each',
            isActive: true,
          },
        });
      }
      stats.products.created++;
    } catch (err) {
      stats.products.errors.push({ name, error: err.message });
    }
  }

  console.log(`[Products] Created ${stats.products.created}, Skipped ${stats.products.skipped}, Errors ${stats.products.errors.length}`);
}

// ── Summary & Audit Log ──────────────────────────────���──────────────────────
function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log(DRY_RUN ? '  DRY RUN SUMMARY (no changes made)' : '  IMPORT SUMMARY');
  console.log('='.repeat(60));
  const table = [];
  for (const [entity, s] of Object.entries(stats)) {
    table.push({
      Entity: entity.charAt(0).toUpperCase() + entity.slice(1),
      Created: s.created,
      Updated: s.updated || '-',
      Skipped: s.skipped,
      Filtered: s.filtered || '-',
      Errors: s.errors?.length || 0,
    });
  }
  console.table(table);

  // Print errors if any
  const allErrors = Object.entries(stats).flatMap(([entity, s]) =>
    (s.errors || []).map(e => ({ entity, ...e }))
  );
  if (allErrors.length > 0) {
    console.log('\nErrors:');
    for (const e of allErrors.slice(0, 20)) {
      console.log(`  [${e.entity}] ${e.name || e.docNum || '?'}: ${e.error}`);
    }
    if (allErrors.length > 20) console.log(`  ... and ${allErrors.length - 20} more`);
  }
}

function writeAuditLog() {
  const logPath = `scripts/import-log-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    writeFileSync(logPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      dryRun: DRY_RUN,
      csvPath: CSV_PATH,
      stats,
      lookupSizes: {
        clients: clientNameToId.size,
        vendors: vendorNameToId.size,
        leads: leadKeyToId.size,
        projects: projectNameToId.size,
        documents: docNumberToId.size,
      },
    }, null, 2));
    console.log(`\nAudit log written to ${logPath}`);
  } catch (err) {
    console.error(`Failed to write audit log: ${err.message}`);
  }
}

// ── Main ─────────────���──────────────────────────────────────────────────────
async function main() {
  console.log(`\nHouzz Pro → ProBuild Import`);
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const content = readFileSync(CSV_PATH, 'utf-8');
  const sections = parseSections(content);

  console.log(`Parsed ${Object.keys(sections).length} sections: ${Object.keys(sections).join(', ')}\n`);

  // Import in dependency order
  await importClients(sections.CLIENTS);
  await importVendors(sections.VENDORS);
  await importLeads(sections.INQUIRIES);
  await importProjects(sections.PROJECTS);
  await importDocuments(sections.DOCUMENTS);
  await importDocumentItems(sections.DOCUMENT_ITEMS);
  await importMilestones(sections.MILESTONES);
  await importNotes(sections.NOTES);
  await importProducts(sections.PRODUCTS);

  printSummary();
  writeAuditLog();
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
