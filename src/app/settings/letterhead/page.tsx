export const dynamic = "force-dynamic";
import { getCompanySettings } from "@/lib/actions";
import LetterheadSettingsClient from "./LetterheadSettingsClient";

export default async function LetterheadPage() {
  const settings = await getCompanySettings();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[720px] py-8 px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-hui-textMain">Letterhead</h1>
          <p className="text-sm text-hui-textMuted mt-1">
            Configure your document letterhead. This appears at the top of
            estimates, invoices, and contracts.
          </p>
        </div>
        <LetterheadSettingsClient initialData={settings} />
      </div>
    </div>
  );
}
