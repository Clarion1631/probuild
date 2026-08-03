import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { H2, P, UL } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
    title: "Privacy Policy | ProBuild",
    description: "How ProBuild collects, uses, and protects your information.",
};

const EFFECTIVE = "August 3, 2026";

export default function PrivacyPolicyPage() {
    return (
        <LegalPage title="Privacy Policy" effective={EFFECTIVE}>
            <P>
                ProBuild is construction project management software for contractors, operated by
                Golden Touch Remodeling LLC (&ldquo;ProBuild&rdquo;, &ldquo;we&rdquo;,
                &ldquo;us&rdquo;). This policy explains what we collect through the ProBuild web
                application and the ProBuild Field mobile app, why we collect it, and what choices
                you have.
            </P>
            <P>
                ProBuild is a business tool. Accounts are created for you by the contracting company
                that employs or engages you. That company controls its own project data and decides
                who on its team can see it.
            </P>

            <H2>Information we collect</H2>
            <P>
                <strong>Account information.</strong> Your name, email address, role, and the
                company you belong to. If you sign in with Google, we receive your Google account
                email, name, and profile picture. We never receive your Google password. Field users
                may instead sign in with a numeric PIN issued by their company.
            </P>
            <P>
                <strong>Location information.</strong> With your permission, the mobile app collects
                your device&rsquo;s precise location to confirm you are at a job site when you clock
                in or out, and to remind you to clock in when you arrive at a scheduled job.
            </P>
            <P>
                <strong>Background location.</strong> If you grant &ldquo;Allow all the time&rdquo;
                (Android) or &ldquo;Always&rdquo; (iOS) permission, the app monitors when you enter
                or leave a job site even when the app is closed or not in use. This exists for one
                purpose: to send you an arrival reminder to clock in, and a departure reminder to
                clock out so you are not paid for time you did not work. Background location is
                optional. If you decline it, every other part of the app keeps working and you can
                still clock in and out manually.
            </P>
            <P>
                <strong>Photos, video, and audio.</strong> With your permission, the app uses your
                camera and photo library so you can attach job site photos to daily logs and
                projects, photograph receipts, record walkthrough videos, and scan rooms in 3D on
                supported devices. Microphone access is used only to record audio as part of a
                walkthrough video you choose to capture.
            </P>
            <P>
                <strong>Work records you create.</strong> Time entries, daily logs, expenses and
                receipt images, schedule and task activity, project notes, and files you upload.
            </P>
            <P>
                <strong>Technical information.</strong> Device model and operating system, app
                version, a push notification token if you enable notifications, and diagnostic
                and crash reports.
            </P>

            <H2>How we use information</H2>
            <UL
                items={[
                    "Provide the service: authenticate you, show your schedule, record your time, and store the work records you create.",
                    "Verify job site presence for time entries, and send arrival and departure reminders.",
                    "Read receipt images to pre-fill expense amounts, vendors, and dates.",
                    "Send notifications you have enabled.",
                    "Keep the service secure, diagnose crashes, and fix defects.",
                    "Meet legal, tax, and payroll recordkeeping obligations.",
                ]}
            />
            <P>
                We do not sell your personal information. We do not share it with data brokers. We
                do not use it to serve advertising, and ProBuild contains no third-party
                advertising.
            </P>

            <H2>Who can see your information</H2>
            <P>
                Your work records are visible to authorized people at the contracting company whose
                account you belong to, according to the role that company assigns you. Managers and
                administrators can generally see the time entries, logs, expenses, and locations
                associated with work performed for that company.
            </P>

            <H2>Service providers</H2>
            <P>
                We use a small number of vendors to run the service. They process data on our
                instructions only:
            </P>
            <UL
                items={[
                    "Supabase — database and file storage (United States).",
                    "Vercel — application hosting.",
                    "Google — sign-in, and automated reading of receipt images you upload.",
                    "Expo — over-the-air app updates and push notification delivery.",
                    "Sentry — crash and error diagnostics.",
                    "Twilio and Resend — text message and email delivery.",
                    "Stripe — payment processing, where a company uses ProBuild to collect customer payments. Card details go directly to Stripe and are never stored by ProBuild.",
                ]}
            />
            <P>
                We may also disclose information if required by law, or to protect the rights,
                safety, or property of ProBuild, our customers, or the public.
            </P>

            <H2>Retention</H2>
            <P>
                We keep work records for as long as the contracting company maintains its ProBuild
                account, because time, expense, and project records are business and payroll records
                that company is often legally required to retain. Location points used for arrival
                and departure detection are retained only as long as needed to support the related
                time entry. When an account is closed, we delete or anonymize personal data within
                90 days, except where longer retention is required by law.
            </P>

            <H2>Deleting your account and data</H2>
            <P>
                You can request deletion of your ProBuild account and associated personal data at
                any time. See{" "}
                <Link href="/account-deletion" className="underline underline-offset-2">
                    account and data deletion
                </Link>{" "}
                for instructions and for what is deleted versus retained.
            </P>

            <H2>Your choices</H2>
            <UL
                items={[
                    "Location: you can grant, downgrade, or revoke location permission at any time in your device settings. Revoking background location disables arrival and departure reminders only.",
                    "Camera, photos, and microphone: each is requested only when you first use the feature, and can be revoked in device settings.",
                    "Notifications: can be turned off in device settings or in the app's Settings screen.",
                    "Access and correction: contact us or your company administrator to review or correct your information.",
                ]}
            />

            <H2>Security</H2>
            <P>
                Data is encrypted in transit using HTTPS and encrypted at rest by our storage
                providers. Sign-in tokens are held in the device keychain or keystore on mobile.
                Access to production systems is limited to personnel who need it. No system is
                perfectly secure, and we cannot guarantee absolute security.
            </P>

            <H2>Children</H2>
            <P>
                ProBuild is a workplace tool intended for people aged 18 and over. It is not
                directed to children, and we do not knowingly collect personal information from
                anyone under 13.
            </P>

            <H2>United States processing</H2>
            <P>
                ProBuild is operated from the United States and information is processed and stored
                there. If you use the service from outside the United States, you understand that
                your information will be transferred to the United States.
            </P>

            <H2>Changes to this policy</H2>
            <P>
                We will update this page when our practices change and revise the effective date
                above. Material changes affecting how we use location data will be communicated in
                the app before they take effect.
            </P>

            <H2>Contact</H2>
            <P>
                Golden Touch Remodeling LLC
                <br />
                Email:{" "}
                <a
                    href="mailto:gtrsupport@goldentouchremodeling.com"
                    className="underline underline-offset-2"
                >
                    gtrsupport@goldentouchremodeling.com
                </a>
            </P>
        </LegalPage>
    );
}
