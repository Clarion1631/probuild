// Config.gs
//
// The Gemini key is NOT in this file. It lives in Script Properties under
// "GEMINI_API_KEY" (Project Settings -> Script Properties), the same place
// SERVICE_ACCOUNT_KEY is kept. A literal here is readable by anyone with edit access to
// the project, and it also rides along into every clasp clone and Drive mirror of it.
function geminiApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY not set in Script Properties.");
  return key;
}
