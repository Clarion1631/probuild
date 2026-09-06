export const INCOMING_EVIDENCE_SOURCES = new Set(["WTB_ONLINE_INCOMING"]);

/** Incoming evidence is display-only until a separately designed workflow exists. */
export function isIncomingEvidenceSource(source: string): boolean {
    return INCOMING_EVIDENCE_SOURCES.has(source);
}
