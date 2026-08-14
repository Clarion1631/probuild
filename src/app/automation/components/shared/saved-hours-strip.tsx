/** The "≈ N hrs of data entry saved this month" gamified strip, with the
 * "on a roll" callout when the hands-free rate is high. */
export function SavedHoursStrip({ hoursSavedLabel, onARoll }: { hoursSavedLabel: string; onARoll: boolean }) {
    return (
        <div className="hui-card p-5">
            <p className="text-sm text-hui-textMain">
                <span className="font-semibold">≈ {hoursSavedLabel} hrs</span> of data entry saved this month
            </p>
            {onARoll && (
                <p className="text-sm text-hui-textMain mt-1">🔥 The robots are on a roll</p>
            )}
        </div>
    );
}
