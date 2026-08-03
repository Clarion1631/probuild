import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { H2, P, UL } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
    title: "Support | ProBuild",
    description: "Get help with ProBuild and the ProBuild Field mobile app.",
};

const EFFECTIVE = "August 3, 2026";
const SUPPORT_EMAIL = "gtrsupport@goldentouchremodeling.com";

export default function SupportPage() {
    return (
        <LegalPage title="Support" effective={EFFECTIVE}>
            <P>
                ProBuild is construction project management software for contractors: crew time
                tracking, daily logs, job site photos, expenses, and schedules in the field, with
                estimating, contracts, and billing back at the office.
            </P>

            <H2>Contact us</H2>
            <P>
                Email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">
                    {SUPPORT_EMAIL}
                </a>
                . We answer during business hours, Monday through Friday, 8am to 5pm Pacific, and
                aim to reply within one business day.
            </P>
            <P>
                When you write in, it helps to include your name, the company your account belongs
                to, the device you are using, and what you were doing when the problem happened.
            </P>

            <H2>Common questions</H2>
            <P>
                <strong>I can&rsquo;t sign in.</strong> ProBuild accounts are created by your
                company&rsquo;s administrator, not by signing up yourself. If your email or PIN is
                rejected, check with your administrator that your account exists and is active. If
                you use Google sign-in, make sure you are picking the same Google account your
                company registered.
            </P>
            <P>
                <strong>I&rsquo;m not getting arrival reminders.</strong> Arrival and departure
                reminders need two things: notification permission, and location permission set to
                &ldquo;Allow all the time&rdquo; on Android or &ldquo;Always&rdquo; on iOS. Open
                Settings inside the app and check the Notifications &amp; Location panel, which
                shows exactly which permissions are granted and lets you re-request them.
            </P>
            <P>
                <strong>My time entry is wrong.</strong> Ask your manager to correct it. Managers
                can edit crew time entries from the ProBuild web app.
            </P>
            <P>
                <strong>Photos or receipts won&rsquo;t upload.</strong> Uploads need a working data
                connection. On a weak job site signal the upload retries; if it keeps failing, try
                again on Wi-Fi.
            </P>

            <H2>Privacy and your data</H2>
            <UL
                items={[
                    <>
                        <Link href="/privacy" className="underline underline-offset-2">
                            Privacy Policy
                        </Link>{" "}
                        — what we collect, including location, and why.
                    </>,
                    <>
                        <Link href="/account-deletion" className="underline underline-offset-2">
                            Delete your account
                        </Link>{" "}
                        — how to request deletion of your account and data.
                    </>,
                    <>
                        <Link href="/terms" className="underline underline-offset-2">
                            Terms of Service
                        </Link>
                    </>,
                ]}
            />
        </LegalPage>
    );
}
