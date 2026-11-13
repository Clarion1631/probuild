// Made-up data only: no real customer names, emails or addresses.
import { deflateSync } from 'node:zlib';
import type { EstimatePdfData } from '../src/lib/pdf';

export const SAMPLE_COMPANY = {
    companyName: 'Sample Remodeling Co.',
    address: '100 Example Way, Sampleville, ST 00000',
    phone: '(555) 010-0000',
    email: 'office@example.test',
    licenseNumber: 'SAMPLE123',
};

export const LONG_TITLE =
    'Primary Bathroom Exhaust Fan Replacement and Ventilation Duct Rerouting Through the Attic to the New Roof Termination Cap';

const base = {
    code: 'EST-00042',
    createdAt: new Date('2026-11-02T12:00:00Z'),
    status: 'Sent',
    project: { name: 'Sample Fan Install', location: '1 Sample Street, Exampletown, ST 00001', client: { name: 'Pat Sample', email: 'pat@example.test' } },
    taxRatePercent: 8.5,
    taxRateName: 'Sample City',
};

export function shortEstimate(): EstimatePdfData {
    return {
        ...base,
        title: LONG_TITLE,
        items: [
            { id: 'a', name: 'Install exhaust fan', description: 'Supply and install a quiet 110 CFM fan.', quantity: 1, unitCost: 450, total: 450, type: 'Labor' },
            { id: 'b', name: 'Duct and termination cap', quantity: 2, unitCost: 62.5, total: 125, type: 'Material' },
        ],
        paymentSchedules: [],
    };
}

export function longEstimate(): EstimatePdfData {
    const items: EstimatePdfData['items'] = [];
    for (let g = 1; g <= 5; g++) {
        let sum = 0;
        const kids: EstimatePdfData['items'] = [];
        for (let i = 1; i <= 9; i++) {
            const total = 100 * g + 17.35 * i;
            sum += total;
            kids.push({
                id: `g${g}i${i}`, parentId: `g${g}`, name: `Group ${g} line item number ${i} with a reasonably long descriptive name`,
                description: 'This description is deliberately long so it wraps onto several lines in the narrow item column. '.repeat(2),
                quantity: i, unitCost: total / i, total,
            });
        }
        items.push({ id: `g${g}`, name: `Phase ${g}: Sample Work Area`, type: 'Section', total: sum }, ...kids);
    }
    return {
        ...base,
        title: 'Whole Home Sample Remodel',
        overviewEnabled: true,
        overviewTitle: 'Project Overview',
        overviewBody: Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1}. We will walk through every room, protect finished surfaces, and keep the site clean each day while the work moves from demolition to finish.</p>`).join(''),
        notesEnabled: true,
        notesBody: '<p>Allowances are estimates. Hidden conditions may change the price.</p>',
        notesPlacement: 'after',
        items,
        paymentSchedules: [
            { name: 'Deposit', percentage: 30, amount: 9000 },
            { name: 'Midpoint', percentage: 40, amount: 12000, dueDate: new Date('2026-12-15T12:00:00Z') },
            { name: 'Final payment on completion', percentage: 30, amount: 9000 },
        ],
    };
}

function crc32(buf: Buffer): number {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

/** A made-up "signature" (a dark sine scribble on transparent) as a PNG data URL; 300x100 by default.
 *  SignaturePad emits 500*DPR x 200*DPR pixels, so a phone gives 1500x600. */
export function sampleSignatureDataUrl(w = 300, h = 100): string {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
    const k = h / 100;
    for (let x = Math.round(10 * k); x < w - Math.round(10 * k); x++) {
        const cy = Math.round(h / 2 + 28 * k * Math.sin(x / (14 * k)) * Math.cos(x / (53 * k)));
        for (let t = -Math.ceil(k); t <= Math.ceil(k); t++) {
            const y = cy + t;
            if (y < 0 || y >= h) continue;
            const o = y * (w * 4 + 1) + 1 + x * 4;
            raw[o] = 20; raw[o + 1] = 30; raw[o + 2] = 90; raw[o + 3] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
    ]);
    return `data:image/png;base64,${png.toString('base64')}`;
}

/** Approved estimate with a signer name, timestamp and drawn signature image. */
export function signedEstimate(): EstimatePdfData {
    return {
        ...shortEstimate(),
        status: 'Approved',
        approvedBy: 'Pat Sample',
        approvedAt: new Date('2026-11-05T17:30:00Z'),
        signatureUrl: sampleSignatureDataUrl(),
    };
}
