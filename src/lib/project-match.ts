// Fuzzy-match an external label ("Mueller Bathroom", a Drive folder name) to a
// ProBuild project ("Mueller Remodel"). Shared by the Drive receipts cron and
// the receipt-ingest endpoint so both route documents identically.

export function normalizeWords(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

export function scoreProjectNameMatch(label: string, projectName: string): number {
    const labelWords = normalizeWords(label);
    if (labelWords.length === 0) return 0;

    const projectWords = normalizeWords(projectName);
    const shared = labelWords.filter(word => projectWords.includes(word)).length;
    // First word (usually the client surname) must match to count at all.
    const firstMatches = projectWords.includes(labelWords[0]);
    return firstMatches ? shared + 1 : shared >= 2 ? shared : 0;
}

/**
 * Return every project tied for the strongest name match. Consumers that
 * mutate financial records must treat more than one result as ambiguous.
 */
export function findBestProjectNameMatches<T extends { id: string; name: string }>(
    label: string,
    projects: T[],
): T[] {
    let bestScore = 0;
    let matches: T[] = [];

    for (const project of projects) {
        const score = scoreProjectNameMatch(label, project.name);
        if (score > bestScore) {
            bestScore = score;
            matches = [project];
        } else if (score > 0 && score === bestScore) {
            matches.push(project);
        }
    }

    return matches;
}

export function matchProjectByName<T extends { id: string; name: string }>(
    label: string,
    projects: T[]
): T | null {
    return findBestProjectNameMatches(label, projects)[0] ?? null;
}

// Match a receipt category ("03 Plumbing", "10 Paint") to a ProBuild cost code
// ("03-PLUMB Plumbing"). Numeric prefixes are compared first (most reliable),
// then name-word overlap.
export function matchCostCode<T extends { id: string; code: string; name: string }>(
    category: string,
    costCodes: T[]
): T | null {
    const catNum = category.match(/^\s*(\d{1,2})\b/)?.[1] ?? null;
    const catWords = normalizeWords(category.replace(/^\s*\d+[\s\-\.]*/, ""));

    let best: { c: T; score: number } | null = null;
    for (const c of costCodes) {
        const codeNum = c.code.match(/^\s*(\d{1,2})\b/)?.[1] ?? null;
        const nameWords = normalizeWords(`${c.code} ${c.name}`);
        let score = 0;
        if (catNum && codeNum && parseInt(catNum, 10) === parseInt(codeNum, 10)) score += 2;
        score += catWords.filter(w => nameWords.includes(w)).length;
        if (score > 0 && (!best || score > best.score)) best = { c, score };
    }
    // Require at least one real signal (number match alone scores 2, word match ≥1)
    return best && best.score >= 2 ? best.c : (best && best.score >= 1 && catWords.length === 1 ? best.c : null);
}
