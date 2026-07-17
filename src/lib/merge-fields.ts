export type MergeFieldDef = {
    key: string;
    label: string;
    example: string;
};

export type MergeFieldCategory = {
    category: string;
    icon: string;
    color: string;
    fields: MergeFieldDef[];
};

export const MERGE_FIELD_CATEGORIES: MergeFieldCategory[] = [
    {
        category: "Client",
        icon: "\u{1F464}",
        color: "blue",
        fields: [
            { key: "client_name", label: "Name", example: "John Doe" },
            { key: "client_email", label: "Email", example: "john@example.com" },
            { key: "client_phone", label: "Phone", example: "(555) 123-4567" },
            { key: "client_address", label: "Address", example: "123 Main St, Los Angeles, CA 90001" },
            { key: "client_additional_email", label: "Additional Email", example: "spouse@example.com" },
            { key: "client_additional_phone", label: "Additional Phone", example: "(555) 000-1234" },
        ],
    },
    {
        category: "Company",
        icon: "\u{1F3E2}",
        color: "purple",
        fields: [
            { key: "company_name", label: "Name", example: "Golden Touch Remodeling" },
            { key: "company_address", label: "Address", example: "456 Business Ave" },
            { key: "company_phone", label: "Phone", example: "(555) 987-6543" },
            { key: "company_email", label: "Email", example: "info@company.com" },
            { key: "company_license", label: "License #", example: "CSLB #123456" },
            { key: "company_website", label: "Website", example: "www.company.com" },
        ],
    },
    {
        category: "Project",
        icon: "\u{1F4CB}",
        color: "green",
        fields: [
            { key: "project_name", label: "Name", example: "Kitchen Remodel" },
            { key: "location", label: "Location", example: "123 Main St, Los Angeles" },
            { key: "project_number", label: "Project #", example: "P-1042" },
            { key: "project_type", label: "Project Type", example: "Kitchen Remodel" },
        ],
    },
    {
        category: "Pricing",
        icon: "\u{1F4B0}",
        color: "emerald",
        fields: [
            { key: "estimate_total", label: "Estimate Total", example: "$45,000" },
            { key: "estimate_number", label: "Estimate #", example: "EST-001" },
            { key: "estimate_balance_due", label: "Balance Due", example: "$22,500" },
            { key: "payment_schedule", label: "Payment Schedule", example: "(formatted table)" },
        ],
    },
    {
        category: "Date",
        icon: "\u{1F4C5}",
        color: "amber",
        fields: [
            { key: "date", label: "Today's Date", example: "March 10, 2026" },
            { key: "year", label: "Year", example: "2026" },
        ],
    },
    {
        category: "Signing",
        icon: "✍️",
        color: "rose",
        fields: [
            { key: "SIGNATURE_BLOCK", label: "Client Signature", example: "[ Click to Sign ]" },
            { key: "INITIAL_BLOCK", label: "Client Initials", example: "[ Click to Initial ]" },
            { key: "DATE_BLOCK", label: "Signed Date", example: "3/27/2026" },
            { key: "CONTRACTOR_SIGNATURE_BLOCK", label: "Contractor Signature", example: "[ Company Signs Here ]" },
        ],
    },
];

export const SIGNING_KEYS = new Set(["SIGNATURE_BLOCK", "INITIAL_BLOCK", "DATE_BLOCK", "CONTRACTOR_SIGNATURE_BLOCK"]);

export const FIELD_LABEL_MAP: Record<string, string> = {};
MERGE_FIELD_CATEGORIES.forEach((cat) =>
    cat.fields.forEach((f) => {
        FIELD_LABEL_MAP[f.key] = f.label;
    })
);

export const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; pill: string }> = {
    blue: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", pill: "bg-blue-100 text-blue-700 hover:bg-blue-200" },
    purple: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200", pill: "bg-purple-100 text-purple-700 hover:bg-purple-200" },
    green: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200", pill: "bg-green-100 text-green-700 hover:bg-green-200" },
    emerald: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", pill: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" },
    amber: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", pill: "bg-amber-100 text-amber-700 hover:bg-amber-200" },
    rose: { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", pill: "bg-rose-100 text-rose-700 hover:bg-rose-200" },
};
