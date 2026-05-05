"use client";

import LetterheadConfigurator from "@/components/LetterheadConfigurator";
import { saveCompanySettings } from "@/lib/actions";

interface Props {
  initialData: Record<string, unknown>;
}

export default function LetterheadSettingsClient({ initialData }: Props) {
  const handleSave = async (letterheadData: Record<string, unknown>) => {
    await saveCompanySettings(letterheadData);
  };

  return <LetterheadConfigurator initialData={initialData} onSave={handleSave} />;
}
