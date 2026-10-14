/** Spellings a route segment cannot carry: product names and acronyms reviewers expect to read. */
const ROUTE_WORDS: Readonly<Record<string, string>> = {
  atm: "ATM",
  atms: "ATMs",
  faq: "FAQ",
  faqs: "FAQs",
  id: "ID",
  ids: "IDs",
  kyc: "KYC",
  otp: "OTP",
  pin: "PIN",
  qr: "QR",
  sms: "SMS",
  url: "URL",
  "2fa": "2FA",
  topup: "Top-up",
  topups: "Top-ups",
  signin: "Sign in",
  signup: "Sign up",
  signout: "Sign out",
  login: "Log in",
  logout: "Log out",
  index: "Root",
};

/**
 * A reviewer-facing title for a route segment or route-derived group name: `atms` reads
 * `ATMs`, `topup` reads `Top-up`, `forgotPassword` reads `Forgot password`. Titles that are
 * already prose keep their words and only gain acronym spellings.
 */
export function humanizeRouteName(value: string): string {
  const words = value
    .replace(/^\(|\)$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._/-]+/)
    .filter(Boolean);
  if (words.length === 0) return value.trim();
  return words
    .map((word, index) => {
      const known = ROUTE_WORDS[word.toLowerCase()];
      if (known) return index === 0 ? known : known === known.toUpperCase() ? known : known.toLowerCase();
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}
