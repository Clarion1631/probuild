// The eight client-facing stages on the portal project tracker.
//
// Pure data with no Prisma import, so client components and server code can
// both use it. lib/portal-tracker.ts re-exports these for existing callers.

export type ClientStageDefinition = {
    label: string;
    matchers: readonly string[];
};

export const CLIENT_STAGES = [
    {
        label: "Planning & Permits",
        matchers: [
            "plan", "permit", "design", "preconstruction", "pre-construction",
            "engineering", "architect", "site prep", "mobilization",
        ],
    },
    {
        label: "Demo",
        matchers: ["demo", "demolition", "tear out", "tear-out", "removal", "abatement"],
    },
    {
        label: "Framing",
        matchers: ["frame", "framing", "structural", "sheathing", "carpentry"],
    },
    {
        label: "Rough-ins",
        matchers: [
            "rough", "plumb", "electric", "hvac", "mechanical", "duct",
            "wiring", "low voltage", "low-voltage",
        ],
    },
    {
        label: "Drywall",
        matchers: ["drywall", "sheetrock", "gypsum", "insulation", "taping", "texture", "mud"],
    },
    {
        label: "Finishes",
        matchers: [
            "finish", "paint", "tile", "cabinet", "floor", "counter", "trim",
            "fixture", "appliance", "millwork", "backsplash",
        ],
    },
    {
        label: "Punch list",
        matchers: [
            "punch", "inspection", "touch up", "touch-up", "cleanup", "clean up",
            "final walk", "correction",
        ],
    },
    {
        label: "Complete",
        matchers: ["complete", "completion", "closeout", "close out", "handover", "handoff"],
    },
] as const satisfies readonly ClientStageDefinition[];

export const CLIENT_STAGE_LABELS: readonly string[] = CLIENT_STAGES.map(stage => stage.label);

/** Index of a stage by its label, or null when the label isn't one of ours. */
export function clientStageIndex(label: string | null | undefined): number | null {
    if (!label) return null;
    const clean = label.trim().toLowerCase();
    const index = CLIENT_STAGES.findIndex(stage => stage.label.toLowerCase() === clean);
    return index >= 0 ? index : null;
}
