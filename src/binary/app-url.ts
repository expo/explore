import { CiError } from "../shared/ci-errors.js";

/** Schemes the OS routes to a browser, the store, Settings, or another app: opening one hands the session away from the app under test. */
const SYSTEM_URL_SCHEMES = /^(https?|ftp|file|javascript|data|blob|mailto|tel|telprompt|facetime(-audio)?|sms|mms|imessage|itms(-apps|-services|-beta)?|macappstore|app-settings|prefs|shortcuts|maps|music|videos|photos-redirect|x-apple-[a-z-]+|market|intent|content|android-app|geo|package):$/i;

const urlError = (code: string, message: string, nextAction: string) => new CiError({ code, stage: "session", message, nextAction });

/** Only the app's own URLs may be opened; an https page or a store link would hand the session to another app. */
export function assertAppUrl(url: string, appSchemes: readonly string[] = []): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw urlError("AGENT_URL_INVALID", `Not a URL: ${url}`, "Pass a custom-scheme app URL."); }
  if (SYSTEM_URL_SCHEMES.test(parsed.protocol)) throw urlError("AGENT_URL_NOT_ALLOWED", `${parsed.protocol} URLs leave the app; only the app's own URL schemes are allowed.`, "Use the app's own URL scheme.");
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (appSchemes.length && !appSchemes.includes(scheme)) {
    throw urlError("AGENT_URL_NOT_ALLOWED", `${parsed.protocol} is not a URL scheme this app registers (${appSchemes.join(", ")}).`, "Use one of the app's own URL schemes.");
  }
}
