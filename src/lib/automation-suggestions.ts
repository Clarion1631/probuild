import type { ReceiptJourney } from "@/lib/automation-events";

/**
 * Failure diagnosis for the Command Center drill-down: for a receipt that
 * didn't book hands-free, explain WHY in plain language and hand the user a
 * ready-to-paste prompt for their AI assistant (Claude) that investigates or
 * fixes it. Deterministic templates keyed on the pipeline's actual
 * reason strings — no model call happens here.
 */

export interface FixSuggestion {
    /** One-line diagnosis, plain English. */
    diagnosis: string;
    /** What a human can do directly, when that's faster than AI. */
    manualFix?: string;
    /** Copy-paste prompt for Claude. */
    aiPrompt: string;
}

function receiptRef(j: ReceiptJourney): string {
    const bits = [j.fileName || `receipt ${j.docNumber}`];
    if (j.vendor) bits.push(`vendor ${j.vendor}`);
    if (j.amountCents != null) bits.push(`$${(j.amountCents / 100).toFixed(2)}`);
    return bits.join(", ");
}

export function suggestFix(journey: ReceiptJourney): FixSuggestion | null {
    const reason = (journey.finalReason ?? "").toLowerCase();
    const ref = receiptRef(journey);

    if (journey.finalState === "booked-api") {
        return null; // fully hands-free — nothing to fix
    }
    // Email-path bookings are safe in the books, but each one is a receipt
    // that did NOT go hands-free; phrase the outcome accurately either way.
    const bookedByEmail = journey.finalState === "booked-email";
    const outcome = bookedByEmail
        ? "It was booked via the email path, so nothing is lost — but it needed Marge instead of going hands-free."
        : "The bot will book it via the email path as a fallback.";

    if (reason.includes("project-not-matched")) {
        return {
            diagnosis: `The intake folder name "${journey.projectName ?? "?"}" doesn't exactly match any In-Progress ProBuild project, so the receipt couldn't be job-coded automatically.`,
            manualFix: "Rename the Drive intake folder (or the ProBuild project) so the two match exactly, then re-drop the file.",
            aiPrompt: `The GTR receipt bot couldn't match the intake folder "${journey.projectName ?? "?"}" to a ProBuild project (receipt: ${ref}). List the current In-Progress ProBuild project names and the Drive intake folder names, tell me which one is misspelled or missing, and fix the folder name so this receipt books automatically.`,
        };
    }
    if (reason.includes("zerototal") || reason.includes("zero") && reason.includes("total")) {
        return {
            diagnosis: "The AI couldn't read a total off this receipt (came through as $0.00), so it was parked in _Needs Review instead of being booked.",
            manualFix: "Open the file in _Needs Review, read the total yourself, and re-drop a clearer photo/scan.",
            aiPrompt: `A receipt was parked as unreadable (${ref}, in the _Needs Review folder in Drive). Open the file, tell me the vendor, date, invoice number, total, and sales tax you can read from it, and whether the image quality is the problem. If you can read it, rename it per the Project_Date_Vendor_Invoice_$Amount convention and move it back to its project's intake folder.`,
        };
    }
    if (journey.finalState === "quarantined" || reason.includes("duplicate")) {
        return {
            diagnosis: "This receipt looks identical to one already processed (same vendor, date, and invoice/amount), so it was quarantined instead of double-booking.",
            manualFix: "If it truly is a second copy, delete it. If it's a genuinely separate purchase, adjust the invoice number on the file name and re-drop it.",
            aiPrompt: `The receipt bot quarantined ${ref} as a possible duplicate (reason: "${journey.finalReason ?? "duplicate"}"). Find both files in Drive, compare them, and tell me whether this is a true duplicate or two separate purchases that happen to look alike. If separate, re-drop the quarantined one with a distinct invoice number.`,
        };
    }
    if (reason.includes("missing-vendor")) {
        return {
            diagnosis: "The AI couldn't read a vendor name off the receipt, and the books never get a purchase without one.",
            aiPrompt: `The receipt bot couldn't extract a vendor from ${ref}. Open the file in Drive, identify the vendor, and tell me whether the receipt layout is unusual — if this vendor's receipts keep failing, suggest a one-line addition to the extraction prompt that would handle their format.`,
        };
    }
    if (reason.includes("invalid-date")) {
        return {
            diagnosis: "The purchase date couldn't be read confidently, and a wrong date would break the bank match.",
            aiPrompt: `The receipt bot couldn't read a valid date from ${ref}. Open the file, tell me the actual purchase date, and check whether the date format on this vendor's receipts (e.g. European day-first) needs a hint added to the extraction prompt.`,
        };
    }
    if (reason.includes("amount-mismatch")) {
        return {
            diagnosis: "The line amounts didn't add up to the receipt total within 2 cents — usually a misread total or tax line.",
            aiPrompt: `The receipt bot rejected ${ref} because its lines didn't reconcile to the total. Open the file, read the subtotal, discounts, tax, and final total, and tell me which number the AI most likely misread. If the receipt shows an unusual layout (e.g. discount after tax), suggest a prompt tweak.`,
        };
    }
    if (reason.includes("account-misconfigured")) {
        return {
            diagnosis: "ProBuild's QuickBooks account configuration failed verification (bank / expense / tax account id wrong or colliding). This blocks the API path for every receipt until fixed.",
            aiPrompt: `The QBO receipt push is reporting "account-misconfigured". Check the env vars QBO_RECEIPT_BANK_ACCOUNT_ID, QBO_RECEIPT_EXPENSE_ACCOUNT_ID and QBO_RECEIPT_TAX_ACCOUNT_ID against the QuickBooks chart of accounts, tell me which one is wrong, and what it should be.`,
        };
    }
    if (reason.includes("qbo-fault")) {
        return {
            diagnosis: `QuickBooks rejected the purchase with a business-rule fault (${journey.finalReason}). ${outcome}`,
            aiPrompt: `QuickBooks rejected the API push for ${ref} with fault "${journey.finalReason}". Look up what this QBO fault code means, check the purchase data that was sent (vendor, date, amounts), and tell me what to change so this class of receipt books automatically next time.`,
        };
    }
    if (reason.includes("file-too-large")) {
        return {
            diagnosis: `The receipt file is over 3 MB, too big to ride the API request. ${outcome} QuickBooks keeps the attachment either way.`,
            manualFix: "Nothing to fix — this is by design. Photos this large usually come from full-resolution phone scans.",
            aiPrompt: `Receipt ${ref} exceeded the 3 MB API attachment limit and took the email path. It still booked fine. If this happens often, investigate whether the intake pipeline should downscale oversized images before processing.`,
        };
    }
    if (reason.includes("no-ingest-key") || reason.includes("gas-flag-off") || reason.includes("push-disabled")) {
        return {
            diagnosis: `The API path was switched off or missing its key when this receipt processed (${journey.finalReason}). ${outcome}`,
            aiPrompt: `Receipt ${ref} fell back to the email path with reason "${journey.finalReason}". Verify the three switches: Apps Script property QBO_API_PUSH_ENABLED, Apps Script property RECEIPT_INGEST_SECRET, and Vercel env QBO_RECEIPT_PUSH_ENABLED. Tell me which one is off or mismatched.`,
        };
    }
    if (reason.includes("unsupported-format")) {
        return {
            diagnosis: `The file format (${journey.finalReason?.split(":")[1] ?? "unknown"}) can't be displayed by QuickBooks or decoded by the bot — HEIC/WEBP/GIF/TIFF/BMP need a re-save.`,
            manualFix: "Open the file in _Needs Review and re-save/export it as a JPG, PNG, or PDF, then drop the new file in the project's intake folder.",
            aiPrompt: `Receipt ${ref} was parked because its format (${journey.finalReason ?? "unsupported"}) isn't supported. Convert it to PDF or JPG, then place the converted file in the correct project intake folder in Drive and confirm the original can be archived.`,
        };
    }
    if (reason.includes("quickbooks-not-connected") || reason.includes("token")) {
        return {
            diagnosis: "ProBuild's QuickBooks connection was down when this receipt tried to book. The bot retries automatically.",
            aiPrompt: `The QBO connection failed for ${ref} ("${journey.finalReason}"). Check whether ProBuild's QuickBooks integration is still connected (Settings → Integrations) and whether the token refresh is failing repeatedly in the logs, or if this was a one-off QuickBooks outage.`,
        };
    }
    if (journey.finalState === "parked") {
        return {
            diagnosis: `The receipt was parked for review${journey.finalReason ? ` (${journey.finalReason})` : ""} — the bot needs a human eye on it.`,
            manualFix: "Open the _Needs Review folder in Drive and check the alert email for details.",
            aiPrompt: `Receipt ${ref} was parked in _Needs Review with reason "${journey.finalReason ?? "unknown"}". Open the file, diagnose why the automation couldn't process it, and either fix and re-drop it or tell me what information is missing.`,
        };
    }
    if (journey.finalState === "error") {
        return {
            diagnosis: `The last attempt hit a transient error (${journey.finalReason ?? "unknown"}) — the bot retries automatically on its next pass.`,
            aiPrompt: `Receipt ${ref} errored with "${journey.finalReason ?? "unknown"}" and is retrying. If it's still not booked an hour from now, investigate: check the Apps Script execution log and ProBuild's function logs for this file id (${journey.docNumber}).`,
        };
    }
    if (journey.finalState === "in-flight") {
        return {
            diagnosis: "Still moving through the pipeline — the next 10-minute pass should advance it.",
            aiPrompt: `Receipt ${ref} has been in-flight since ${journey.lastSeen.toISOString()}. If it hasn't booked within 30 minutes, check the Apps Script execution log for its file id (${journey.docNumber}) and tell me which stage it's stuck at.`,
        };
    }
    return null;
}
