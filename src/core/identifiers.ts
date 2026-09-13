/**
 * Read-only reports over the four Mexican identifiers.
 *
 * All arithmetic — the RFC's modulus-11 digit, the CURP's base-37 digit, the
 * CLABE's 3-7-1 control digit and the NSS's Luhn digit — lives in the
 * `mx-identifiers` package and is NOT reimplemented here. This module only adds
 * the reporting layer an agent needs: legible error codes, catalogue labels and
 * findings.
 */

import {
  CLABE_BANKS,
  CURP_STATES,
  GENERIC_RFCS,
  formatClabe,
  normalizeClabe,
  normalizeCurp,
  normalizeNss,
  normalizeRfc,
  rfcCheckDigit,
  validateClabe,
  validateCurp,
  validateNss,
  validateRfc,
} from "mx-identifiers";
import type { Finding } from "../format.js";

/** One validation failure, with the terse code from `mx-identifiers` explained. */
export interface IdentifierError {
  code: string;
  message: string;
}

/** Explanations for the codes `mx-identifiers` emits, per identifier. */
const ERROR_TEXT: Record<string, Record<string, string>> = {
  rfc: {
    empty: "The input is empty once separators and spaces are stripped.",
    length:
      "An RFC is 12 characters for a company (persona moral) or 13 for an individual (persona física).",
    shape:
      "Wrong shape: it must be 3 or 4 letters, then 6 digits (YYMMDD), then a 3-character homoclave.",
    date: "The 6 digits in positions 4-9 (or 5-10) are not a real calendar date.",
    checksum:
      "The final check digit does not match the modulus-11 result over the preceding characters.",
    inconvenient:
      "The four leading letters spell a word RENAPO/SAT replaces with an X — a real RFC would not carry it.",
  },
  curp: {
    empty: "The input is empty once separators and spaces are stripped.",
    length: "A CURP is exactly 18 characters.",
    shape:
      "Wrong shape: 4 letters, 6 digits (YYMMDD), H/M/X, a 2-letter state key, 3 internal consonants, a homoclave character and the check digit.",
    date: "The 6 digits in positions 5-10 are not a real calendar date.",
    state: "Positions 12-13 are not one of the 32 RENAPO state keys (or NE for born abroad).",
    checksum:
      "The final check digit does not match the base-37 modulus-10 result over the first 17 characters.",
    inconvenient:
      "The four leading letters spell a word RENAPO substitutes — a real CURP would carry an X in the second position.",
  },
  clabe: {
    empty: "The input is empty once separators and spaces are stripped.",
    digits: "A CLABE contains digits only.",
    length: "A CLABE is exactly 18 digits: 3 bank + 3 plaza + 11 account + 1 control.",
    checksum:
      "The control digit does not match. Note each 3-7-1 weighted product counts only its last digit (9 × 7 = 63 counts 3) — implementations that add the product's digits Luhn-style (6 + 3 = 9) compute a different control digit.",
  },
  nss: {
    empty: "The input is empty once separators and spaces are stripped.",
    digits: "An NSS contains digits only.",
    length:
      "An NSS is exactly 11 digits: 2 subdelegación + 2 registration year + 2 birth year + 4 serial + 1 check digit.",
    checksum: "The final check digit does not match the Luhn result over the first 10 digits.",
  },
};

function explain(kind: keyof typeof ERROR_TEXT, codes: string[]): IdentifierError[] {
  return codes.map((code) => ({
    code,
    message: ERROR_TEXT[kind]?.[code] ?? `Validation failed with code '${code}'.`,
  }));
}

// --- RFC --------------------------------------------------------------------

export interface RfcReport {
  input: string;
  normalized: string;
  valid: boolean;
  kind: string | null;
  is_generic: boolean;
  generic_note: string | null;
  parts: { iniciales: string; fecha: string; homoclave: string; digito: string } | null;
  birth_date: string | null;
  expected_check_digit: string | null;
  check_digit_satisfied: boolean | null;
  errors: IdentifierError[];
  findings: Finding[];
}

/**
 * The two RFCs the SAT assigned by decree. They do not behave the same way and
 * the difference trips up almost every home-grown validator:
 *
 *   XAXX010101000 (público en general) does NOT satisfy the modulus-11 digit —
 *     the algorithm asks for a 4 where the SAT wrote a 0. It is valid because
 *     the SAT says so, not because the arithmetic works.
 *   XEXX010101000 (residentes en el extranjero) DOES satisfy it on its own.
 *
 * `mx-identifiers` allow-lists both; this layer reports which is which so an
 * agent never claims the first one "passes the check digit".
 */
function genericFindings(normalized: string): Finding[] {
  const expected = rfcCheckDigit(normalized.slice(0, -1));
  const actual = normalized.slice(-1);
  const satisfies = expected === actual;
  return [
    {
      severity: "info",
      message: `${normalized} is a generic RFC published by the SAT (${GENERIC_RFCS[normalized]}). It is accepted by decree.`,
    },
    {
      severity: satisfies ? "pass" : "warn",
      message: satisfies
        ? `Its check digit also satisfies the modulus-11 algorithm on its own (expected ${expected}, found ${actual}), so it would validate even without the allow-list.`
        : `Its check digit does NOT satisfy the modulus-11 algorithm: the algorithm asks for '${expected}' where the SAT wrote '${actual}'. Any validator without an explicit allow-list rejects it — which is why so many billing forms refuse invoices to the general public.`,
    },
  ];
}

export function reportRfc(input: string): RfcReport {
  const result = validateRfc(input);
  const normalized = normalizeRfc(input);
  const isGeneric = result.kind === "generico";

  const findings: Finding[] = [];
  if (isGeneric) {
    findings.push(...genericFindings(result.normalized));
  } else if (result.valid) {
    findings.push({
      severity: "pass",
      message: `Structurally valid RFC for a ${result.kind === "fisica" ? "persona física (individual)" : "persona moral (company)"}.`,
    });
  } else {
    findings.push({ severity: "fail", message: "Not a structurally valid RFC." });
  }
  if (result.valid && !isGeneric) {
    findings.push({
      severity: "info",
      message:
        "Structural validity is not registration: only the SAT can confirm an RFC is registered and active. This server never queries that.",
    });
  }

  return {
    input,
    normalized,
    valid: result.valid,
    kind: result.kind,
    is_generic: isGeneric,
    generic_note: result.genericNote ?? null,
    parts: result.parts,
    birth_date: result.birthDate,
    // For the SAT generics mx-identifiers echoes the digit as written; report the
    // one the algorithm computes, or `expected 0` sits next to `not satisfied`.
    expected_check_digit:
      isGeneric && result.normalized.length >= 12
        ? rfcCheckDigit(result.normalized.slice(0, -1))
        : result.expectedCheckDigit,
    check_digit_satisfied:
      result.normalized.length >= 12
        ? rfcCheckDigit(result.normalized.slice(0, -1)) === result.normalized.slice(-1)
        : null,
    errors: explain("rfc", result.errors),
    findings,
  };
}

// --- CURP -------------------------------------------------------------------

export interface CurpReport {
  input: string;
  normalized: string;
  valid: boolean;
  parts: {
    iniciales: string;
    fecha: string;
    sexo: string;
    entidad: string;
    consonantes: string;
    homoclave: string;
    digito: string;
  } | null;
  birth_date: string | null;
  sex: string | null;
  sex_label: string | null;
  state_key: string | null;
  state_name: string | null;
  /** The 17th character is a digit for people born before 2000, a letter from 2000 onwards. */
  century_marker: string | null;
  expected_check_digit: string | null;
  errors: IdentifierError[];
  findings: Finding[];
}

const SEX_LABEL: Record<string, string> = {
  H: "Hombre (male)",
  M: "Mujer (female)",
  X: "No binario (non-binary)",
};

export function reportCurp(input: string): CurpReport {
  const result = validateCurp(input);
  const findings: Finding[] = [];

  if (result.valid) {
    findings.push({ severity: "pass", message: "Structurally valid CURP." });
    findings.push({
      severity: "info",
      message:
        "Structural validity is not registration: only RENAPO can confirm the CURP belongs to a real person. This server never queries RENAPO.",
    });
  } else {
    findings.push({ severity: "fail", message: "Not a structurally valid CURP." });
  }

  const homoclave = result.parts?.homoclave ?? null;
  if (homoclave) {
    // RENAPO's rule: a digit for births up to 1999, a letter from 2000 onwards.
    // It is what resolves the two-digit year, so the birth date above is read
    // through it and the two cannot disagree.
    findings.push({
      severity: "info",
      message: /[0-9]/.test(homoclave)
        ? `The homoclave character is a digit ('${homoclave}'), which marks a birth before 2000 — so the year is read as 19${result.birthDate?.slice(2, 4) ?? "YY"}.`
        : `The homoclave character is a letter ('${homoclave}'), which marks a birth from 2000 onwards — so the year is read as 20${result.birthDate?.slice(2, 4) ?? "YY"}.`,
    });
  }

  return {
    input,
    normalized: normalizeCurp(input),
    valid: result.valid,
    parts: result.parts,
    birth_date: result.birthDate,
    sex: result.sexLabel,
    sex_label: result.sexLabel ? (SEX_LABEL[result.sexLabel] ?? null) : null,
    state_key: result.parts?.entidad ?? null,
    state_name: result.stateName,
    century_marker: homoclave,
    expected_check_digit: result.expectedCheckDigit,
    errors: explain("curp", result.errors),
    findings,
  };
}

// --- CLABE ------------------------------------------------------------------

export interface ClabeReport {
  input: string;
  normalized: string;
  formatted: string | null;
  valid: boolean;
  parts: { banco: string; plaza: string; cuenta: string; digito: string } | null;
  bank_code: string | null;
  bank_name: string | null;
  plaza_code: string | null;
  plaza_note: string | null;
  expected_check_digit: string | null;
  errors: IdentifierError[];
  findings: Finding[];
}

export function reportClabe(input: string): ClabeReport {
  const result = validateClabe(input);
  const findings: Finding[] = [];
  const bankCode = result.parts?.banco ?? null;

  if (result.valid) {
    findings.push({ severity: "pass", message: "Structurally valid CLABE." });
  } else {
    findings.push({ severity: "fail", message: "Not a structurally valid CLABE." });
  }

  if (bankCode) {
    if (result.bankName) {
      findings.push({
        severity: "info",
        message: `Bank code ${bankCode} belongs to ${result.bankName} in Banxico's participant catalogue.`,
      });
    } else {
      findings.push({
        severity: "warn",
        message: `Bank code ${bankCode} is not in the bundled Banxico subset. The CLABE can still be arithmetically correct — the code is simply not one of the institutions this server carries, and no name is invented for it.`,
      });
    }
  }

  return {
    input,
    normalized: normalizeClabe(input),
    formatted: result.valid ? formatClabe(result.normalized) : null,
    valid: result.valid,
    parts: result.parts,
    bank_code: bankCode,
    bank_name: result.bankName,
    plaza_code: result.parts?.plaza ?? null,
    plaza_note: result.parts
      ? "Digits 4-6 are the Banxico plaza (city/branch) code. The full plaza catalogue is not bundled, so the code is reported verbatim rather than guessed at."
      : null,
    expected_check_digit: result.expectedCheckDigit,
    errors: explain("clabe", result.errors),
    findings,
  };
}

/** Every bank code the server can name, for `sat_catalog_lookup`. */
export function knownBanks(): Array<{ code: string; label: string }> {
  return Object.entries(CLABE_BANKS).map(([code, label]) => ({ code, label }));
}

/** Every CURP state key the server can name, for `sat_catalog_lookup`. */
export function knownStates(): Array<{ code: string; label: string }> {
  return Object.entries(CURP_STATES).map(([code, label]) => ({ code, label }));
}

// --- NSS --------------------------------------------------------------------

export interface NssReport {
  input: string;
  normalized: string;
  valid: boolean;
  parts: {
    subdelegacion: string;
    anioAlta: string;
    anioNacimiento: string;
    folio: string;
    digito: string;
  } | null;
  expected_check_digit: string | null;
  errors: IdentifierError[];
  findings: Finding[];
}

export function reportNss(input: string): NssReport {
  const result = validateNss(input);
  const findings: Finding[] = [];

  if (result.valid) {
    findings.push({ severity: "pass", message: "Structurally valid NSS (Luhn check digit matches)." });
    findings.push({
      severity: "info",
      message:
        "The two-digit fields are the IMSS subdelegación, the year of registration and the year of birth. They are informational: the IMSS has issued numbers whose years do not line up with the holder's records, so do not reject a number over them.",
    });
  } else {
    findings.push({ severity: "fail", message: "Not a structurally valid NSS." });
  }

  return {
    input,
    normalized: normalizeNss(input),
    valid: result.valid,
    parts: result.parts,
    expected_check_digit: result.expectedCheckDigit,
    errors: explain("nss", result.errors),
    findings,
  };
}
