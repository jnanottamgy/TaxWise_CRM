/**
 * Password policy (§4.4): at least 8 characters, an uppercase letter, a lowercase letter, a digit
 * and a symbol. Pure and client-safe: the live checklist under every password field, the zod
 * schemas in lib/schemas/auth.ts and the server actions all use these same rules.
 *
 * The character classes are ASCII on purpose. They match Supabase Auth's own "password
 * requirements" setting, so a password this checklist accepts is never refused for its characters.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** Supabase Auth hashes with bcrypt, which ignores everything after 72 bytes. */
export const PASSWORD_MAX_LENGTH = 72;

export type PasswordRuleId = "length" | "upper" | "lower" | "digit" | "symbol";

interface PasswordRule {
  id: PasswordRuleId;
  /** Checklist line under the field. */
  label: string;
  /** The same requirement inside a sentence: "Your password needs …". */
  phrase: string;
  test: (password: string) => boolean;
}

const SYMBOL = /[!-/:-@[-`{-~]/; // every printable ASCII character that is not a letter or a digit

const RULES: readonly PasswordRule[] = [
  {
    id: "length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    phrase: `at least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH,
  },
  { id: "upper", label: "An uppercase letter", phrase: "an uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { id: "lower", label: "A lowercase letter", phrase: "a lowercase letter", test: (p) => /[a-z]/.test(p) },
  { id: "digit", label: "A number", phrase: "a number", test: (p) => /[0-9]/.test(p) },
  { id: "symbol", label: "A symbol, such as ! @ # $ %", phrase: "a symbol", test: (p) => SYMBOL.test(p) },
];

export interface PasswordCheck {
  rule: PasswordRuleId;
  label: string;
  ok: boolean;
}

/** One line per rule, in checklist order, with whether the password meets it. */
export function checkPassword(password: string): PasswordCheck[] {
  return RULES.map((r) => ({ rule: r.id, label: r.label, ok: r.test(password) }));
}

/** True when every rule is met and the password is not longer than bcrypt can use. */
export function meetsPasswordPolicy(password: string): boolean {
  return password.length <= PASSWORD_MAX_LENGTH && RULES.every((r) => r.test(password));
}

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * One plain sentence naming what is missing, or null when the password meets the policy.
 * "Your password needs an uppercase letter and a symbol."
 */
export function passwordPolicyMessage(password: string): string | null {
  if (password.length === 0) return "Enter a password.";
  if (password.length > PASSWORD_MAX_LENGTH) return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  const missing = RULES.filter((r) => !r.test(password)).map((r) => r.phrase);
  if (missing.length === 0) return null;
  return `Your password needs ${joinPhrases(missing)}.`;
}

// -------------------------------------------------------------------------------------------------
// Temporary passwords (§4.5): issued by a Partner or Manager, shared once (copy, WhatsApp, Gmail).
// -------------------------------------------------------------------------------------------------

// No look-alikes (0/O, 1/l/I), because people read these aloud and retype them from a phone.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
// No * _ ~ ` (WhatsApp turns them into formatting) and no quotes, spaces or backslashes.
const SYMBOLS = "!@#$%&?=+";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

export const TEMPORARY_PASSWORD_LENGTH = 14;

/** A uniformly random index below `n`, from the platform CSPRNG, without modulo bias. */
function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)];
}

/**
 * A crypto-random temporary password that always meets the policy: one character from each class,
 * the rest from all of them, then shuffled (Fisher–Yates). Length is clamped to 12–64.
 */
export function generateTemporaryPassword(length: number = TEMPORARY_PASSWORD_LENGTH): string {
  const size = Math.min(64, Math.max(12, Math.floor(length)));
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < size) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** The alphabets, exported for tests. */
export const TEMPORARY_PASSWORD_ALPHABET = { UPPER, LOWER, DIGITS, SYMBOLS } as const;
