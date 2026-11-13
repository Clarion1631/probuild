// Made-up data only: no real customer names, emails or addresses.
import type { InvoicePdfData, ChangeOrderPdfData } from '../src/lib/pdf';
import { SAMPLE_COMPANY as BASE_COMPANY, sampleSignatureDataUrl as baseSig } from './estimate-pdf-fixtures';
export { SAMPLE_COMPANY, sampleSignatureDataUrl } from './estimate-pdf-fixtures';

/** A made-up logo (PNG bytes; the file is never fetched: tests pass the bytes in). */
export const SAMPLE_LOGO_URL = 'https://logo.example.test/logo.png';
export function sampleLogoBytes(w = 240, h = 80): Uint8Array {
    return new Uint8Array(Buffer.from(baseSig(w, h).split(',')[1], 'base64'));
}
/** The sample company with a configured logo. */
export const SAMPLE_COMPANY_WITH_LOGO = { ...BASE_COMPANY, logoUrl: SAMPLE_LOGO_URL };

export const FIXED_NOW = new Date('2026-11-12T20:00:00Z');
export const LA = 'America/Los_Angeles';

const client = { name: 'Pat Sample', email: 'pat@example.test' };
const project = { name: 'Sample Fan Install', location: '1 Sample Street, Exampletown, ST 00001', client };

/** Not sent, not focused: "No Payment Due". balanceDue is deliberately stored (not recomputed). */
export function shortInvoice(): InvoicePdfData {
    return {
        code: 'INV-00042', status: 'Partially Paid',
        createdAt: new Date('2026-11-03T06:30:00Z'), issueDate: null,
        totalAmount: 1500, balanceDue: 1000, notes: 'Thank you for your business.',
        client: null, project,
        payments: [
            { id: 'p1', name: 'Deposit', amount: 500, status: 'Paid', dueDate: new Date('2026-11-01T00:00:00Z'), paymentDate: new Date('2026-11-02T00:00:00Z'), qbInvoiceSentAt: new Date('2026-10-30T18:00:00Z') },
            { id: 'p2', name: 'Midpoint', amount: 600, status: 'Pending', dueDate: new Date('2026-12-01T00:00:00Z'), qbInvoiceSentAt: null },
            { id: 'p3', name: 'Final payment', amount: 400, status: 'Pending', dueDate: null, qbInvoiceSentAt: null },
        ],
    };
}

/** One requested (sent, past due) row and one sent row not yet due. */
export function dueInvoice(): InvoicePdfData {
    const inv = shortInvoice();
    inv.payments = [
        { id: 'p1', name: 'Deposit', amount: 500, status: 'Paid', dueDate: new Date('2026-11-01T00:00:00Z'), paymentDate: new Date('2026-11-05T19:30:00Z'), qbInvoiceSentAt: new Date('2026-10-30T18:00:00Z') },
        { id: 'p2', name: 'Midpoint', amount: 600, status: 'Pending', dueDate: new Date('2026-11-05T00:00:00Z'), qbInvoiceSentAt: new Date('2026-11-01T18:00:00Z') },
        { id: 'p3', name: 'Cabinets', amount: 250, status: 'Pending', dueDate: new Date('2026-12-20T00:00:00Z'), qbInvoiceSentAt: new Date('2026-11-10T18:00:00Z') },
        { id: 'p4', name: 'Final payment', amount: 150, status: 'Pending', dueDate: null, qbInvoiceSentAt: null },
    ];
    inv.totalAmount = 1500; inv.balanceDue = 1000; inv.issueDate = new Date('2026-11-04T20:00:00Z');
    return inv;
}

export function allPaidInvoice(): InvoicePdfData {
    const inv = shortInvoice();
    inv.status = 'Paid'; inv.balanceDue = 0;
    inv.payments = inv.payments.map(p => ({ ...p, status: 'Paid', paymentDate: new Date('2026-11-09T00:00:00Z') }));
    return inv;
}

export function longInvoice(): InvoicePdfData {
    const inv = shortInvoice();
    inv.project = {
        name: 'Whole Home Sample Remodel with an Unusually Long Project Name That Needs Several Lines to Print Completely',
        location: '1234 Sample Boulevard Northeast, Building C, Suite 200, Exampletown, ST 00001, near the second loading dock',
        client,
    };
    inv.payments = Array.from({ length: 60 }, (_, i) => ({
        id: `p${i}`, name: i === 7 ? 'Milestone seven: ' + 'a very long payment description that keeps going '.repeat(4).trim() : `Milestone ${i + 1}`,
        amount: 100 + i, status: i < 10 ? 'Paid' : 'Pending',
        dueDate: new Date(Date.UTC(2026, 10, 1 + (i % 28))), paymentDate: i < 10 ? new Date('2026-11-02T00:00:00Z') : null,
        qbInvoiceSentAt: i % 3 === 0 ? new Date('2026-11-01T00:00:00Z') : null,
    }));
    inv.totalAmount = 9000; inv.balanceDue = 8000;
    inv.notes = Array.from({ length: 40 }, (_, i) => `Notes paragraph ${i + 1}. Payment is due within 14 days of each request and every change is confirmed in writing before work begins.`).join('\n\n') + '\n\nLAST-NOTES-PARAGRAPH';
    return inv;
}

const coBase: ChangeOrderPdfData = {
    code: 'CO-00007', title: 'Add pantry shelving', description: 'Add built-in shelving in the pantry per the walkthrough.',
    status: 'Sent', createdAt: new Date('2026-11-03T06:30:00Z'), pricingType: 'FIXED', markupPercent: null, totalAmount: 600,
    project, estimate: { code: 'EST-00042', taxExempt: false, taxRatePercent: 8.5, taxRateName: 'Sample City' },
    items: [
        { type: 'Material', name: 'Shelving lumber', description: 'Clear pine, painted.', quantity: 4, unitCost: 100, total: 400 },
        { type: 'Labor', name: 'Install shelving', quantity: 2, unitCost: 100, total: 200 },
    ],
    paymentSchedules: [],
};

export function fixedSignedCo(): ChangeOrderPdfData {
    return {
        ...coBase, status: 'Approved',
        title: 'Add pantry shelving and relocate the existing outlet, switch plate and ceiling light to the new wall layout as discussed on site',
        approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-06T05:30:00Z'), clientSignatureUrl: 'sig',
        companySignedBy: 'Sam Contractor', companySignedAt: new Date('2026-11-07T17:00:00Z'), companySignatureUrl: 'sig',
        estimate: { code: 'EST-00042', taxExempt: false, taxRatePercent: 8.5, taxRateName: 'Sample City Special Purpose Transportation District Levy' },
        paymentSchedules: [
            { name: 'Deposit', amount: 300, dueDate: new Date('2026-12-01T00:00:00Z') },
            { name: 'Final payment on completion', amount: 300, dueDate: null },
        ],
    };
}

export function costPlusCo(): ChangeOrderPdfData {
    return {
        ...coBase, pricingType: 'COST_PLUS', markupPercent: 12, status: 'Sent',
        paymentSchedules: [{ name: 'Should not print', amount: 1, dueDate: new Date('2026-12-01T00:00:00Z') }],
    };
}

export function creditCo(): ChangeOrderPdfData {
    return {
        ...coBase, title: 'Remove planned backsplash',
        totalAmount: -250, items: [{ type: 'Material', name: 'Backsplash tile (removed)', quantity: 1, unitCost: -250, total: -250 }],
    };
}

export function offlineCo(): ChangeOrderPdfData {
    return {
        ...coBase, status: 'Approved', approvalSource: 'OFFLINE', approvalMethod: 'PHONE', approvedBy: null,
        approvedAt: new Date('2026-11-08T18:00:00Z'), approvalNote: 'SECRET-NOTE-XYZ',
    } as ChangeOrderPdfData;
}

export function longCo(): ChangeOrderPdfData {
    const items = Array.from({ length: 40 }, (_, i) => ({
        type: 'Material', name: `Line item ${i + 1} with a reasonably long descriptive name`,
        description: 'This description is deliberately long so it wraps onto several lines in the narrow item column. '.repeat(2),
        quantity: i + 1, unitCost: 10, total: (i + 1) * 10,
    }));
    const sum = items.reduce((a, it) => a + it.total, 0);
    return {
        ...coBase, items, totalAmount: sum,
        description: Array.from({ length: 12 }, (_, i) => `Reason paragraph ${i + 1}. We will walk every room and keep the site clean each day.`).join('\n\n'),
        paymentSchedules: Array.from({ length: 50 }, (_, i) => ({ name: `Schedule row ${i + 1}`, amount: 10 + i, dueDate: new Date(Date.UTC(2026, 11, 1 + (i % 28))) })),
    };
}

/** Stored totalAmount differs from the item sum. */
export function driftCo(): ChangeOrderPdfData {
    return { ...coBase, totalAmount: 650 };
}

/** One line's stored total differs from quantity x unit price (stored subtotal still matches the items). */
export function lineDriftCo(): ChangeOrderPdfData {
    return { ...coBase, items: [{ type: 'Material', name: 'Shelving lumber', quantity: 4, unitCost: 100, total: 399 }, { type: 'Labor', name: 'Install shelving', quantity: 2, unitCost: 100, total: 200 }] };
}

export function emptyCo(): ChangeOrderPdfData {
    return { ...coBase, items: [], totalAmount: 0 };
}

/** One fixed-price line with the given quantity (unit price 10). */
export function qtyCo(quantity: number): ChangeOrderPdfData {
    const total = Math.round(quantity * 10 * 100) / 100;
    return { ...coBase, totalAmount: total, items: [{ type: 'Material', name: 'Cabinet screws', quantity, unitCost: 10, total }] };
}
