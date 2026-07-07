// Source of truth for GTR's standard estimate templates ("chunks" + room templates).
// Structure mirrors the proven "Bathroom Remodel" template: phases (Section rows with
// a cost code) containing typed line items with real-world starting rates drawn from
// estimate history (labor $55-65/hr, subs $105-115/hr, dust control ~$2k, dumpster $450...).
// Phase order follows the Project Book production sequence (Phase 0 Precon -> 14 Completion).
// Applied to the DB by seed-estimate-templates.ts (idempotent upsert by template name).

export type SeedItem = {
    name: string;
    type: "Labor" | "Material" | "Allowance" | "Subcontractor" | "Equipment" | "Other";
    quantity: number;
    unitCost: number;
    description?: string;
    costCode?: string; // overrides the phase cost code
};

export type SeedPhase = {
    name: string;
    costCode: string;
    items: SeedItem[];
};

export type SeedTemplate = {
    name: string;
    phases: SeedPhase[];
};

// ── Shared chunks: the repeatable procedure blocks nearly every job includes ──

const SUPPORT_CHUNK: SeedPhase[] = [
    {
        name: "Project Support & Site Services",
        costCode: "20-CLEAN",
        items: [
            { name: "Floor & Wall Protection / Dust Containment", type: "Labor", quantity: 1, unitCost: 1200, costCode: "28-MISC" },
            { name: "Dust Control Package", type: "Material", quantity: 1, unitCost: 850, costCode: "28-MISC" },
            { name: "Portable Toilet Rental (monthly)", type: "Equipment", quantity: 1, unitCost: 140 },
            { name: "Dumpster / Debris Removal", type: "Equipment", quantity: 1, unitCost: 450 },
            { name: "Progress Job Site Cleanup", type: "Labor", quantity: 8, unitCost: 55 },
        ],
    },
];

const PERMITS_CHUNK: SeedPhase[] = [
    {
        name: "Permits & Design",
        costCode: "21-PERMITS",
        items: [
            { name: "Building Permit", type: "Other", quantity: 1, unitCost: 850 },
            { name: "Permit Expediting & Coordination", type: "Labor", quantity: 3, unitCost: 65 },
            { name: "Design & Engineering Allowance", type: "Allowance", quantity: 1, unitCost: 1500, costCode: "22-DESIGN" },
        ],
    },
];

const DEMO_CHUNK: SeedPhase[] = [
    {
        name: "Demolition",
        costCode: "01-DEMO",
        items: [
            { name: "Demolition - Labor", type: "Labor", quantity: 16, unitCost: 55 },
            { name: "Dumpster / Debris Removal", type: "Equipment", quantity: 1, unitCost: 450 },
            { name: "Dump Fees & Disposal", type: "Other", quantity: 1, unitCost: 175 },
        ],
    },
];

const MEP_ROUGH_CHUNK: SeedPhase[] = [
    {
        name: "Plumbing Rough-In",
        costCode: "03-PLUMB",
        items: [
            { name: "Rough-In Plumbing", type: "Subcontractor", quantity: 12, unitCost: 115 },
            { name: "Plumbing Rough Materials", type: "Material", quantity: 1, unitCost: 420 },
        ],
    },
    {
        name: "Electrical Rough-In",
        costCode: "04-ELEC",
        items: [
            { name: "Electrical Rough-In", type: "Subcontractor", quantity: 8, unitCost: 105 },
            { name: "Electrical Rough Materials", type: "Material", quantity: 1, unitCost: 280 },
        ],
    },
    {
        name: "HVAC Rough-In",
        costCode: "05-HVAC",
        items: [
            { name: "HVAC Rough-In / Duct Modifications", type: "Subcontractor", quantity: 6, unitCost: 105 },
        ],
    },
];

const MEP_FINISH_CHUNK: SeedPhase[] = [
    {
        name: "Plumbing Finish",
        costCode: "03-PLUMB",
        items: [
            { name: "Plumbing Trim-Out", type: "Subcontractor", quantity: 6, unitCost: 115 },
            { name: "Plumbing Fixture Allowance", type: "Allowance", quantity: 1, unitCost: 2100, costCode: "19-FIXTURE" },
        ],
    },
    {
        name: "Electrical Finish",
        costCode: "04-ELEC",
        items: [
            { name: "Electrical Trim-Out", type: "Subcontractor", quantity: 4, unitCost: 105 },
            { name: "Electrical Finish Items Allowance", type: "Allowance", quantity: 1, unitCost: 1000, costCode: "19-FIXTURE" },
        ],
    },
];

const CLOSEOUT_CHUNK: SeedPhase[] = [
    {
        name: "Closeout & Punch List",
        costCode: "28-MISC",
        items: [
            { name: "Punch List Labor", type: "Labor", quantity: 12, unitCost: 55 },
            { name: "Touch-Up Paint & Materials", type: "Material", quantity: 1, unitCost: 250, costCode: "08-PAINT" },
            { name: "Final Clean", type: "Subcontractor", quantity: 1, unitCost: 450, costCode: "20-CLEAN" },
        ],
    },
];

// ── Room templates ──

const KITCHEN_REMODEL: SeedPhase[] = [
    ...PERMITS_CHUNK,
    ...SUPPORT_CHUNK,
    ...DEMO_CHUNK,
    {
        name: "Framing & Blocking",
        costCode: "02-FRAME",
        items: [
            { name: "Blocking & Backing / Wall Modifications", type: "Labor", quantity: 8, unitCost: 65 },
            { name: "Framing Materials", type: "Material", quantity: 1, unitCost: 250 },
        ],
    },
    ...MEP_ROUGH_CHUNK,
    {
        name: "Drywall",
        costCode: "07-DRYWALL",
        items: [
            { name: "Drywall Hang, Tape & Finish", type: "Subcontractor", quantity: 1, unitCost: 1990 },
            { name: "Drywall Materials", type: "Material", quantity: 1, unitCost: 350 },
        ],
    },
    {
        name: "Paint",
        costCode: "08-PAINT",
        items: [
            { name: "Paint Kitchen (walls, ceiling, trim)", type: "Subcontractor", quantity: 1, unitCost: 1600 },
        ],
    },
    {
        name: "Cabinetry",
        costCode: "11-CABINET",
        items: [
            { name: "Cabinet Allowance", type: "Allowance", quantity: 1, unitCost: 12000 },
            { name: "Cabinet Installation", type: "Labor", quantity: 24, unitCost: 65 },
        ],
    },
    {
        name: "Countertops",
        costCode: "12-COUNTER",
        items: [
            { name: "Countertop Allowance (quartz/granite)", type: "Allowance", quantity: 1, unitCost: 4500 },
        ],
    },
    {
        name: "Tile Backsplash",
        costCode: "10-TILE",
        items: [
            { name: "Backsplash Tile Allowance", type: "Allowance", quantity: 1, unitCost: 650 },
            { name: "Backsplash Installation", type: "Labor", quantity: 12, unitCost: 65 },
        ],
    },
    {
        name: "Flooring",
        costCode: "09-FLOOR",
        items: [
            { name: "Flooring Allowance", type: "Allowance", quantity: 1, unitCost: 1800 },
            { name: "Flooring Installation", type: "Labor", quantity: 1, unitCost: 1100 },
            { name: "Underlayment", type: "Material", quantity: 1, unitCost: 300 },
        ],
    },
    ...MEP_FINISH_CHUNK,
    {
        name: "Appliances",
        costCode: "18-APPLIANCE",
        items: [
            { name: "Appliance Allowance", type: "Allowance", quantity: 1, unitCost: 6000 },
            { name: "Appliance Install & Hookup", type: "Labor", quantity: 6, unitCost: 65 },
        ],
    },
    ...CLOSEOUT_CHUNK,
];

const SINGLE_ROOM_REMODEL: SeedPhase[] = [
    ...SUPPORT_CHUNK,
    ...DEMO_CHUNK,
    {
        name: "Drywall Repair",
        costCode: "07-DRYWALL",
        items: [
            { name: "Drywall Repair & Skim", type: "Labor", quantity: 8, unitCost: 55 },
            { name: "Drywall Materials", type: "Material", quantity: 1, unitCost: 180 },
        ],
    },
    {
        name: "Paint",
        costCode: "08-PAINT",
        items: [
            { name: "Paint Room (walls, ceiling, trim)", type: "Subcontractor", quantity: 1, unitCost: 1200 },
        ],
    },
    {
        name: "Flooring",
        costCode: "09-FLOOR",
        items: [
            { name: "Flooring Allowance (LVP/carpet)", type: "Allowance", quantity: 1, unitCost: 1400 },
            { name: "Flooring Installation", type: "Labor", quantity: 1, unitCost: 800 },
            { name: "Underlayment", type: "Material", quantity: 1, unitCost: 200 },
        ],
    },
    {
        name: "Trim & Millwork",
        costCode: "13-TRIM",
        items: [
            { name: "Baseboard & Casing Install", type: "Labor", quantity: 8, unitCost: 65 },
            { name: "Millwork Materials", type: "Material", quantity: 1, unitCost: 350 },
        ],
    },
    {
        name: "Electrical Finish",
        costCode: "04-ELEC",
        items: [
            { name: "Electrical R&R (outlets, switches, fixtures)", type: "Subcontractor", quantity: 4, unitCost: 105 },
            { name: "Lighting Fixture Allowance", type: "Allowance", quantity: 1, unitCost: 500, costCode: "19-FIXTURE" },
        ],
    },
    ...CLOSEOUT_CHUNK,
];

const WHOLE_HOUSE_REMODEL: SeedPhase[] = [
    ...PERMITS_CHUNK,
    ...SUPPORT_CHUNK,
    {
        name: "Strategic Demolition",
        costCode: "01-DEMO",
        items: [
            { name: "Whole House Demolition - Labor", type: "Labor", quantity: 80, unitCost: 55 },
            { name: "Dumpsters / Debris Removal", type: "Equipment", quantity: 4, unitCost: 450 },
            { name: "Dump Fees & Disposal", type: "Other", quantity: 4, unitCost: 175 },
        ],
    },
    {
        name: "Floor System & Structural",
        costCode: "02-FRAME",
        items: [
            { name: "Structural Framing Package", type: "Subcontractor", quantity: 1, unitCost: 6200 },
            { name: "Structural Materials", type: "Material", quantity: 1, unitCost: 2400 },
            { name: "Engineering Allowance", type: "Allowance", quantity: 1, unitCost: 1200, costCode: "22-DESIGN" },
        ],
    },
    {
        name: "Wall Framing",
        costCode: "02-FRAME",
        items: [
            { name: "Wall Framing - Labor", type: "Labor", quantity: 60, unitCost: 65 },
            { name: "Framing Materials", type: "Material", quantity: 1, unitCost: 1800 },
        ],
    },
    ...MEP_ROUGH_CHUNK,
    {
        name: "Insulation",
        costCode: "06-INSUL",
        items: [
            { name: "Insulation (walls & ceiling)", type: "Subcontractor", quantity: 1, unitCost: 2200 },
        ],
    },
    {
        name: "Drywall",
        costCode: "07-DRYWALL",
        items: [
            { name: "Drywall Hang, Tape & Finish - Whole House", type: "Subcontractor", quantity: 1, unitCost: 9500 },
            { name: "Drywall Materials", type: "Material", quantity: 1, unitCost: 2100 },
        ],
    },
    {
        name: "Paint",
        costCode: "08-PAINT",
        items: [
            { name: "Paint - Whole House Interior", type: "Subcontractor", quantity: 1, unitCost: 7500 },
        ],
    },
    {
        name: "Interior Finishes - Flooring",
        costCode: "09-FLOOR",
        items: [
            { name: "Flooring Allowance - Whole House", type: "Allowance", quantity: 1, unitCost: 9000 },
            { name: "Flooring Installation", type: "Labor", quantity: 1, unitCost: 4500 },
            { name: "Underlayment", type: "Material", quantity: 1, unitCost: 1200 },
        ],
    },
    {
        name: "Interior Finishes - Trim & Doors",
        costCode: "13-TRIM",
        items: [
            { name: "Trim & Millwork Package", type: "Labor", quantity: 60, unitCost: 65 },
            { name: "Millwork Materials", type: "Material", quantity: 1, unitCost: 2800 },
            { name: "Interior Door Allowance", type: "Allowance", quantity: 1, unitCost: 2400, costCode: "14-DOOR" },
        ],
    },
    ...MEP_FINISH_CHUNK,
    ...CLOSEOUT_CHUNK,
];

// "Package" = reusable scope block (matches how GTR already names estimate
// sections: "Millwork Package", "Appliance Package"...). Room templates are
// full project blueprints composed of the same phases.
export const SEED_TEMPLATES: SeedTemplate[] = [
    { name: "Site Services Package", phases: SUPPORT_CHUNK },
    { name: "Permits & Design Package", phases: PERMITS_CHUNK },
    { name: "Demolition Package", phases: DEMO_CHUNK },
    { name: "MEP Rough-In Package", phases: MEP_ROUGH_CHUNK },
    { name: "MEP Finish Package", phases: MEP_FINISH_CHUNK },
    { name: "Closeout & Punch List Package", phases: CLOSEOUT_CHUNK },
    { name: "Kitchen Remodel", phases: KITCHEN_REMODEL },
    { name: "Single Room Remodel", phases: SINGLE_ROOM_REMODEL },
    { name: "Whole House Remodel", phases: WHOLE_HOUSE_REMODEL },
];

// Superseded names cleaned up by the seeder so renames don't leave duplicates.
export const RETIRED_TEMPLATE_NAMES: string[] = [
    "Chunk — Project Support & Site Services",
    "Chunk — Permits & Design",
    "Chunk — Demolition",
    "Chunk — MEP Rough-In",
    "Chunk — MEP Finish",
    "Chunk — Closeout & Punch List",
];
