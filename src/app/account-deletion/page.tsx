import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { H2, P, UL } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
    title: "Delete Your Account | ProBuild",
    description: "How to request deletion of your ProBuild account and associated data.",
};

const EFFECTIVE = "August 3, 2026";
const SUPPORT_EMAIL = "gtrsupport@goldentouchremodeling.com";

export default function AccountDeletionPage() {
    return (
        <LegalPage title="Delete Your Account" effective={EFFECTIVE}>
            <P>
                This page explains how to request deletion of your ProBuild account and the data
                associated with it. It applies to both the ProBuild web application and the ProBuild
                Field mobile app (<code className="text-[13px]">com.goldentouchremodeling.probuild</code>
                ).
            </P>

            <H2>How to request deletion</H2>
            <P>
                Email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}?subject=ProBuild%20account%20deletion%20request`} className="underline underline-offset-2">
                    {SUPPORT_EMAIL}
                </a>{" "}
                from the email address on your ProBuild account, with the subject line
                &ldquo;Account deletion request&rdquo;. Tell us the name of the company your account
                belongs to so we can locate it.
            </P>
            <P>
                We verify that the request comes from the account holder, then confirm by email when
                the deletion is complete. We aim to complete requests within 30 days and will not
                take longer than 90 days.
            </P>
            <P>
                You can also ask your company&rsquo;s ProBuild administrator to deactivate your
                account immediately. Deactivation blocks sign-in right away; a deletion request
                additionally removes the underlying data as described below.
            </P>

            <H2>What gets deleted</H2>
            <UL
                items={[
                    "Your user profile: name, email address, profile photo, role, and PIN.",
                    "Your linked Google sign-in association.",
                    "Location points collected for job site arrival, departure, and clock-in verification.",
                    "Push notification tokens and device identifiers tied to your account.",
                    "Photos, videos, and receipt images you uploaded that are not attached to a completed project record.",
                ]}
            />

            <H2>What is retained, and why</H2>
            <P>
                Some records cannot be deleted on request because the contracting company that
                employs or engages you is legally required to keep them:
            </P>
            <UL
                items={[
                    "Time entries and payroll records — retained for the period required by federal and state wage and hour law, generally at least three years.",
                    "Expense records, receipts, and financial transactions — retained for tax and accounting purposes, generally at least seven years.",
                    "Project records such as daily logs, contracts, change orders, and job site documentation — retained as business and warranty records for the contracting company.",
                ]}
            />
            <P>
                Where we retain these records, we disassociate them from your personal profile and
                keep only the minimum needed to satisfy the obligation. They are not used for any
                other purpose.
            </P>

            <H2>Deleting the app</H2>
            <P>
                Uninstalling the ProBuild Field app removes the app and its locally stored sign-in
                token from your device, but does not by itself delete your account. Use the email
                request above to delete the account.
            </P>

            <H2>Questions</H2>
            <P>
                See our{" "}
                <Link href="/privacy" className="underline underline-offset-2">
                    Privacy Policy
                </Link>{" "}
                for the full description of what we collect and how long we keep it, or write to{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">
                    {SUPPORT_EMAIL}
                </a>
                .
            </P>
        </LegalPage>
    );
}
