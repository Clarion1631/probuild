import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { H2, P, UL } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
    title: "Terms of Service | ProBuild",
    description: "The terms that govern your use of ProBuild.",
};

const EFFECTIVE = "August 3, 2026";

export default function TermsPage() {
    return (
        <LegalPage title="Terms of Service" effective={EFFECTIVE}>
            <P>
                These terms govern your use of ProBuild, construction project management software
                operated by Golden Touch Remodeling LLC (&ldquo;ProBuild&rdquo;, &ldquo;we&rdquo;,
                &ldquo;us&rdquo;), including the ProBuild web application and the ProBuild Field
                mobile app. By using ProBuild you agree to these terms.
            </P>

            <H2>Accounts</H2>
            <P>
                ProBuild accounts are provisioned by the contracting company that employs or engages
                you. That company decides who gets an account, what role each account holds, and
                what data each role can see. You must be at least 18 years old to use ProBuild.
            </P>
            <P>
                You are responsible for keeping your sign-in credentials, including any PIN issued
                to you, confidential, and for activity that occurs under your account. Tell your
                administrator promptly if you believe your account has been compromised.
            </P>

            <H2>Acceptable use</H2>
            <P>You agree not to:</P>
            <UL
                items={[
                    "Use ProBuild for any unlawful purpose, or in violation of your employer's policies.",
                    "Access data belonging to a company you are not authorized to act for.",
                    "Falsify time entries, job site locations, expenses, or project records.",
                    "Attempt to probe, scan, or breach the security of the service, or interfere with its operation.",
                    "Reverse engineer, resell, or redistribute the service except as permitted by law.",
                    "Upload malicious code, or content you do not have the right to upload.",
                ]}
            />

            <H2>Your content</H2>
            <P>
                You and your company retain ownership of the photos, logs, documents, and other
                content you put into ProBuild. You grant us the limited license needed to host,
                process, back up, and display that content in order to operate the service. We do
                not sell your content and we do not use it for advertising.
            </P>

            <H2>Location features</H2>
            <P>
                ProBuild uses device location to verify job site presence and to send arrival and
                departure reminders. Location accuracy depends on your device, your operating
                system&rsquo;s permission settings, and network conditions. Reminders are a
                convenience and are not guaranteed to arrive. You remain responsible for the
                accuracy of your own time entries. See the{" "}
                <Link href="/privacy" className="underline underline-offset-2">
                    Privacy Policy
                </Link>{" "}
                for how location data is handled.
            </P>

            <H2>Availability and changes</H2>
            <P>
                We aim to keep ProBuild available but do not guarantee uninterrupted service.
                Maintenance, updates, and provider outages can interrupt access. We may add, change,
                or discontinue features. If we make a materially adverse change to a paid plan, we
                will give reasonable notice.
            </P>

            <H2>Termination</H2>
            <P>
                Your company may deactivate your account at any time. We may suspend or terminate
                access that violates these terms or that poses a security or legal risk. You may
                stop using ProBuild at any time and may request deletion of your account as
                described on the{" "}
                <Link href="/account-deletion" className="underline underline-offset-2">
                    account deletion
                </Link>{" "}
                page.
            </P>

            <H2>Disclaimers</H2>
            <P>
                ProBuild is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without
                warranties of any kind, whether express or implied, including implied warranties of
                merchantability, fitness for a particular purpose, and non-infringement. ProBuild is
                a recordkeeping tool. It is not legal, tax, accounting, payroll, or engineering
                advice, and it does not guarantee compliance with any wage, tax, licensing, or
                building requirement.
            </P>

            <H2>Limitation of liability</H2>
            <P>
                To the fullest extent permitted by law, ProBuild and its officers, employees, and
                suppliers will not be liable for indirect, incidental, special, consequential, or
                punitive damages, or for lost profits, revenue, or data, arising out of or relating
                to your use of the service. Our total liability for any claim relating to the
                service will not exceed the greater of one hundred US dollars or the amount your
                company paid us for the service in the twelve months before the claim arose.
            </P>

            <H2>Indemnity</H2>
            <P>
                You agree to indemnify and hold ProBuild harmless from claims arising out of your
                misuse of the service, your violation of these terms, or your violation of the
                rights of another.
            </P>

            <H2>Governing law</H2>
            <P>
                These terms are governed by the laws of the State of Washington, without regard to
                its conflict of laws rules. The exclusive venue for any dispute is the state or
                federal courts located in Washington, and you consent to their jurisdiction.
            </P>

            <H2>Changes to these terms</H2>
            <P>
                We may update these terms and will revise the effective date above. Continued use
                after an update means you accept the revised terms.
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
