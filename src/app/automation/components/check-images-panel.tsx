import { formatCurrency } from "@/lib/utils";
import type { CheckImagePanelRow } from "../check-images-data";
import ConfirmMatchButton from "./check-image-confirm-button";

/**
 * "Check images" panel (Automation page): the human worklist for the
 * check-payer pipeline. Each card shows one BankImage with its extracted
 * payer/memo evidence, the fuzzy Client/Project suggestions, and — when the
 * matcher proposes exactly one ledger line — an explicit CONFIRM action.
 *
 * Suggestions are suggestions. Only the Confirm button (its server action)
 * writes BankImageMatch, and only per image, by a signed-in internal user.
 *
 * Server component — the only interactive bit is ConfirmMatchButton.
 */

const KIND_LABELS: Record<string, string> = {
    CHECK_FRONT: "Check front",
    CHECK_BACK: "Check back",
    DEPOSIT_SLIP: "Deposit slip",
    DEPOSIT_PHOTO: "Deposit photo",
};

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return "—";
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function Label({ children }: { children: React.ReactNode }) {
    return <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{children}</p>;
}

function SuggestionList({ title, matches, hrefBase }: {
    title: string;
    matches: { id: string; name: string; score: number }[];
    hrefBase: string | null;
}) {
    if (matches.length === 0) return null;
    return (
        <div>
            <Label>{title}</Label>
            <ul className="mt-1 space-y-0.5">
                {matches.map((m) => (
                    <li key={m.id} className="text-sm text-hui-textMain flex items-baseline gap-2">
                        {hrefBase ? (
                            <a href={`${hrefBase}/${m.id}`} className="font-medium text-hui-primary hover:underline">
                                {m.name}
                            </a>
                        ) : (
                            <span className="font-medium">{m.name}</span>
                        )}
                        <span className="text-xs text-hui-textMuted tabular-nums">{Math.round(m.score * 100)}% similar</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function ImageCard({ row }: { row: CheckImagePanelRow }) {
    const kindLabel = row.incomingEvidence ? "Incoming check" : KIND_LABELS[row.kind] ?? row.kind;
    const hasSuggestions = row.payerMatches.length > 0 || row.memoMatches.length > 0;

    return (
        <div className="border border-hui-border rounded-lg p-4 space-y-3">
            {/* Identity line */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <p className="text-sm font-semibold text-hui-textMain">
                        {kindLabel}
                        {row.normalizedCheckNumber && <span className="ml-1.5 text-hui-textMuted font-normal">chk#{row.normalizedCheckNumber}</span>}
                    </p>
                    <p className="text-xs text-hui-textMuted mt-0.5">
                        {row.fileName} · captured {fmtDate(row.capturedAt)}
                        {row.documentDate && ` · dated ${fmtDate(row.documentDate)}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {row.amountCents !== null && (
                        <span className="text-sm font-medium text-hui-textMain tabular-nums">
                            {formatCurrency(row.amountCents / 100)}
                        </span>
                    )}
                    {row.imageUrl ? (
                        <a
                            href={row.imageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-hui-primary hover:underline"
                        >
                            Redacted image ↗
                        </a>
                    ) : row.driveFileId && (
                        <a
                            href={`https://drive.google.com/file/d/${encodeURIComponent(row.driveFileId)}/view`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-hui-primary hover:underline"
                        >
                            Image ↗
                        </a>
                    )}
                </div>
            </div>

            {/* Extraction evidence */}
            {row.incomingEvidence ? (
                <p className="text-sm text-hui-textMuted italic">Read-only incoming evidence. It is excluded from automated matching and confirmation.</p>
            ) : !row.extracted ? (
                <p className="text-sm text-hui-textMuted italic">Not yet extracted — run the check-payer extraction to read this image.</p>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <Label>Payer (from image)</Label>
                        <p className="text-sm text-hui-textMain mt-0.5">{row.payerName ?? <span className="text-hui-textMuted italic">not readable — needs a human</span>}</p>
                    </div>
                    <div>
                        <Label>Memo</Label>
                        <p className="text-sm text-hui-textMain mt-0.5">{row.memoText ?? <span className="text-hui-textMuted">(blank)</span>}</p>
                    </div>
                </div>
            )}

            {/* Fuzzy suggestions */}
            {row.extracted && hasSuggestions && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-slate-100">
                    <SuggestionList title="Payer looks like client" matches={row.payerMatches} hrefBase={null} />
                    <SuggestionList title="Memo looks like project" matches={row.memoMatches} hrefBase="/projects" />
                </div>
            )}
            {row.extracted && !hasSuggestions && (row.payerName || row.memoText) && (
                <p className="text-xs text-hui-textMuted">No client or project is a close enough name match to suggest.</p>
            )}

            {/* Confirmed / proposed / unmatched — exactly one of the three */}
            {row.confirmed ? (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                    <p className="text-sm font-medium text-green-800">
                        Confirmed → {row.confirmed.lineDescriptor ?? "bank line"}
                        {row.confirmed.lineAmountCents !== null && ` · ${formatCurrency(Math.abs(row.confirmed.lineAmountCents) / 100)}`}
                        {row.confirmed.linePostedDate && ` · posted ${fmtDate(row.confirmed.linePostedDate)}`}
                    </p>
                    <p className="text-xs text-green-700 mt-0.5">
                        by {row.confirmed.confirmedBy} on {fmtDate(row.confirmed.confirmedAt)}
                    </p>
                </div>
            ) : row.proposal ? (
                <div className="bg-slate-50 border border-hui-border rounded-lg px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
                    <div>
                        <p className="text-sm text-hui-textMain">
                            <span className="font-medium">Suggested bank line:</span> {row.proposal.lineDescriptor}
                            {` · ${formatCurrency(Math.abs(row.proposal.lineAmountCents) / 100)}`}
                            {row.proposal.linePostedDate && ` · posted ${fmtDate(row.proposal.linePostedDate)}`}
                        </p>
                        <p className="text-xs text-hui-textMuted mt-0.5">{row.proposal.reason}</p>
                    </div>
                    <ConfirmMatchButton
                        bankImageId={row.id}
                        bankLineId={row.proposal.bankLineId}
                        note={row.proposal.reason}
                    />
                </div>
            ) : (
                <p className="text-xs text-hui-textMuted">
                    {row.unmatchedDetail ?? "No bank line to suggest for this image."}
                </p>
            )}
        </div>
    );
}

export function CheckImagesPanel({ rows, totalImages }: { rows: CheckImagePanelRow[]; totalImages: number }) {
    return (
        <div className="hui-card p-5 space-y-4">
            <div>
                <h2 className="text-base font-semibold text-hui-textMain">Check images</h2>
                <p className="text-sm text-hui-textMuted mt-1">
                    Check and deposit images with payee and memo details. Suggested matches need your review.
                    {totalImages > rows.length && ` Showing the ${rows.length} most recent of ${totalImages} images.`}
                </p>
            </div>
            {rows.length === 0 ? (
                <p className="text-sm text-hui-textMuted py-6 text-center">
                    No check or deposit images pulled from the bank yet.
                </p>
            ) : (
                <div className="space-y-3">
                    {rows.map((row) => <ImageCard key={row.id} row={row} />)}
                </div>
            )}
        </div>
    );
}
