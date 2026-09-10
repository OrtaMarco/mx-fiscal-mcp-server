/**
 * The four identifier validators plus the test-data generator.
 */

import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { field, renderFindings, respond, responseFormatField, table } from "../format.js";
import { reportClabe, reportCurp, reportNss, reportRfc } from "../core/identifiers.js";
import { generateTestData } from "../core/testdata.js";
import { ClabeSchema, CurpSchema, NssSchema, RfcSchema, TestDataSchema } from "../schemas.js";
import { MAX_GENERATED_RECORDS } from "../constants.js";
import { READ_ONLY, identifierInput } from "./_shared.js";

export function registerIdentifierTools(server: McpServer): void {
  // --- validate_rfc --------------------------------------------------------

  server.registerTool(
    "validate_rfc",
    {
      title: "Validate RFC",
      description: `Validate a Mexican RFC (Registro Federal de Contribuyentes) — the SAT taxpayer ID — and break it into its parts. Works for both shapes: 13 characters for a persona física (individual) and 12 for a persona moral (company).

The last character is a modulus-11 check digit over the preceding ones, and this checks it. Two SAT-issued generics are special-cased and reported as such:

  - **XAXX010101000** (público en general) does NOT satisfy the check-digit algorithm — the arithmetic asks for a '4' where the SAT wrote a '0'. It is valid by decree, not by maths, which is exactly why so many home-grown validators wrongly reject invoices to the general public.
  - **XEXX010101000** (residentes en el extranjero) DOES satisfy it on its own.

The tool reports \`is_generic\` and \`check_digit_satisfied\` separately so you never have to conflate the two.

**Structural validity is not registration.** A well-formed RFC may belong to nobody. Only the SAT can say whether one is registered and active, and this server never asks.

Args:
  - value (string): the RFC. Spaces, dashes and lower case are normalised away.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { input, normalized, valid, kind, is_generic, generic_note, parts{iniciales, fecha, homoclave, digito}, birth_date, expected_check_digit, check_digit_satisfied, errors[{code, message}], findings[] }.

Example: "Is GODE561231GR8 a valid RFC?" -> validate_rfc(value="GODE561231GR8").`,
      inputSchema: identifierInput(
        "The RFC to validate, e.g. 'GODE561231GR8' (individual) or 'MAB9307148T4' (company).",
      ),
      outputSchema: RfcSchema,
      annotations: READ_ONLY,
    },
    async ({ value, response_format }) => {
      const report = reportRfc(value);
      return respond(report, response_format, () =>
        [
          `# RFC ${report.normalized || "(empty)"}`,
          "",
          `${report.valid ? "✅ Structurally valid" : "❌ Not valid"}${
            report.kind ? ` · ${report.kind === "fisica" ? "persona física" : report.kind === "moral" ? "persona moral" : "generic"}` : ""
          }`,
          "",
          field("Normalised", report.normalized),
          field("Kind", report.kind),
          field("Leading letters", report.parts?.iniciales),
          field("Date section", report.parts?.fecha),
          field("Birth / incorporation date", report.birth_date),
          field("Homoclave", report.parts?.homoclave),
          field("Check digit", report.parts?.digito),
          field("Expected check digit", report.expected_check_digit),
          "",
          ...(report.errors.length
            ? ["## Errors", ...report.errors.map((e) => `- \`${e.code}\` — ${e.message}`), ""]
            : []),
          renderFindings(report.findings),
        ].join("\n"),
      );
    },
  );

  // --- validate_curp -------------------------------------------------------

  server.registerTool(
    "validate_curp",
    {
      title: "Validate CURP",
      description: `Validate a Mexican CURP (Clave Única de Registro de Población) — the 18-character population ID issued by RENAPO — and decode everything it encodes: birth date, sex, state of birth and the century marker.

The 18th character is a base-37 modulus-10 check digit over the first 17, and this checks it. Two details it gets right that a regex does not:

  - **The state keys are RENAPO's own.** 'DF' is Ciudad de México, 'MC' is Estado de México, 'NE' means born abroad. They do not match the INEGI or ISO 3166-2:MX codes, so a lookup against those tables silently mislabels people.
  - **The homoclave character carries the century.** A digit means born from 2000 onwards; a letter means before 2000. Without it, positions 5-10 ('99' as a year) are ambiguous.

Names that would spell one of RENAPO's inconvenient words are flagged: a real CURP carries an X in the second position instead.

**Structural validity is not registration.** Only RENAPO can confirm a CURP belongs to a real person, and this server never asks it.

Args:
  - value (string): the CURP. Spaces, dashes and lower case are normalised away.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { input, normalized, valid, parts{...}, birth_date, sex, sex_label, state_key, state_name, century_marker, expected_check_digit, errors[{code, message}], findings[] }.

Example: "Decode BOXW310820HNERXN09" -> validate_curp(value="BOXW310820HNERXN09").`,
      inputSchema: identifierInput("The CURP to validate, e.g. 'BOXW310820HNERXN09'."),
      outputSchema: CurpSchema,
      annotations: READ_ONLY,
    },
    async ({ value, response_format }) => {
      const report = reportCurp(value);
      return respond(report, response_format, () =>
        [
          `# CURP ${report.normalized || "(empty)"}`,
          "",
          report.valid ? "✅ Structurally valid" : "❌ Not valid",
          "",
          field("Normalised", report.normalized),
          field("Birth date", report.birth_date),
          field("Sex", report.sex_label),
          field("State of birth", report.state_name ? `${report.state_key} — ${report.state_name}` : report.state_key),
          field("Century marker", report.century_marker),
          field("Internal consonants", report.parts?.consonantes),
          field("Check digit", report.parts?.digito),
          field("Expected check digit", report.expected_check_digit),
          "",
          ...(report.errors.length
            ? ["## Errors", ...report.errors.map((e) => `- \`${e.code}\` — ${e.message}`), ""]
            : []),
          renderFindings(report.findings),
        ].join("\n"),
      );
    },
  );

  // --- validate_clabe ------------------------------------------------------

  server.registerTool(
    "validate_clabe",
    {
      title: "Validate CLABE",
      description: `Validate an 18-digit CLABE (Clave Bancaria Estandarizada, Banxico Circular 3/2012) — the account number every SPEI transfer in Mexico is addressed to — and name the bank behind it.

Structure: 3 digits of bank + 3 of plaza (city/branch) + 11 of account + 1 control digit.

**The control digit is the part everybody gets wrong.** The weights cycle 3-7-1, and each weighted product is reduced modulo 10 *before* being added to the sum. Implementations that sum the products first — the Luhn habit — accept and reject the wrong numbers. This uses the correct algorithm.

The bank code is resolved against a curated subset of Banxico's participant catalogue. A code that is not in the subset is reported as unknown rather than given an invented name. The plaza code is reported verbatim: the full plaza catalogue is not bundled, so no city is guessed.

Args:
  - value (string): the CLABE. Spaces and dashes are normalised away.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { input, normalized, formatted, valid, parts{banco, plaza, cuenta, digito}, bank_code, bank_name, plaza_code, plaza_note, expected_check_digit, errors[{code, message}], findings[] }.

Example: "Which bank is CLABE 012180012345678903?" -> validate_clabe(value="012180012345678903").`,
      inputSchema: identifierInput("The CLABE to validate, e.g. '012180012345678903'."),
      outputSchema: ClabeSchema,
      annotations: READ_ONLY,
    },
    async ({ value, response_format }) => {
      const report = reportClabe(value);
      return respond(report, response_format, () =>
        [
          `# CLABE ${report.formatted ?? report.normalized ?? "(empty)"}`,
          "",
          report.valid ? "✅ Structurally valid" : "❌ Not valid",
          "",
          field("Normalised", report.normalized),
          field("Bank", report.bank_name ? `${report.bank_code} — ${report.bank_name}` : report.bank_code),
          field("Plaza code", report.plaza_code),
          field("Account", report.parts?.cuenta),
          field("Control digit", report.parts?.digito),
          field("Expected control digit", report.expected_check_digit),
          "",
          ...(report.errors.length
            ? ["## Errors", ...report.errors.map((e) => `- \`${e.code}\` — ${e.message}`), ""]
            : []),
          renderFindings(report.findings),
        ].join("\n"),
      );
    },
  );

  // --- validate_nss --------------------------------------------------------

  server.registerTool(
    "validate_nss",
    {
      title: "Validate NSS (IMSS)",
      description: `Validate an 11-digit NSS (Número de Seguridad Social) issued by the IMSS, and split it into its fields: 2 digits of subdelegación, 2 of the year the holder was registered, 2 of the year of birth, 4 of serial, and a Luhn check digit over the first ten.

The two year fields are informational only. The IMSS has issued numbers whose years do not line up with the holder's records, so a mismatch is not grounds to reject a number — only the check digit is.

Args:
  - value (string): the NSS. Spaces and dashes are normalised away.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { input, normalized, valid, parts{subdelegacion, anioAlta, anioNacimiento, folio, digito}, expected_check_digit, errors[{code, message}], findings[] }.

Example: "Is 12345678903 a valid NSS?" -> validate_nss(value="12345678903").`,
      inputSchema: identifierInput("The NSS to validate, e.g. '92119624722'."),
      outputSchema: NssSchema,
      annotations: READ_ONLY,
    },
    async ({ value, response_format }) => {
      const report = reportNss(value);
      return respond(report, response_format, () =>
        [
          `# NSS ${report.normalized || "(empty)"}`,
          "",
          report.valid ? "✅ Structurally valid" : "❌ Not valid",
          "",
          field("Normalised", report.normalized),
          field("Subdelegación", report.parts?.subdelegacion),
          field("Year of registration", report.parts?.anioAlta),
          field("Year of birth", report.parts?.anioNacimiento),
          field("Serial", report.parts?.folio),
          field("Check digit", report.parts?.digito),
          field("Expected check digit", report.expected_check_digit),
          "",
          ...(report.errors.length
            ? ["## Errors", ...report.errors.map((e) => `- \`${e.code}\` — ${e.message}`), ""]
            : []),
          renderFindings(report.findings),
        ].join("\n"),
      );
    },
  );

  // --- generate_test_data --------------------------------------------------

  server.registerTool(
    "generate_test_data",
    {
      title: "Generate Mexican Test Data",
      description: `Generate structurally valid Mexican identifiers for fixtures, database seeds and demos — no real person or company involved.

For a **person** each record carries a coherent set: the RFC and the CURP are derived from the *same* name, sex, birth date and state, the CLABE's bank code is a real Banxico participant, and the NSS satisfies its Luhn digit. For a **company**, a razón social with a matching persona-moral RFC and a CLABE.

Why generated instead of hand-written: an RFC or CURP typed by hand almost never satisfies its check digit, so it fails the first validation your own code runs, and a seed file full of 'AAAA010101AAA' teaches your tests nothing.

**These pass validation and belong to nobody.** They are not registered at the SAT, RENAPO, IMSS or Banxico — do not send them to the SAT's status service or to a PAC.

Args:
  - kind ('person' | 'company'): what to generate (default 'person').
  - count (integer 1-${MAX_GENERATED_RECORDS}): how many records (default 1).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { kind, count, people[{nombre, apellido_paterno, apellido_materno, sexo, fecha_nacimiento, entidad, entidad_nombre, rfc, curp, clabe, banco, nss, codigo_postal, telefono, email}], companies[{razon_social, rfc, clabe, banco, codigo_postal, fecha_constitucion}], findings[] }.

Example: "Give me 5 fake Mexican customers with valid RFC and CURP" -> generate_test_data(kind="person", count=5).`,
      inputSchema: z.object({
        kind: z
          .enum(["person", "company"])
          .default("person")
          .describe("'person' for individuals (RFC + CURP + CLABE + NSS), 'company' for personas morales."),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_GENERATED_RECORDS)
          .default(1)
          .describe(`How many records to generate, 1-${MAX_GENERATED_RECORDS}.`),
        response_format: responseFormatField,
      }),
      outputSchema: TestDataSchema,
      annotations: READ_ONLY,
    },
    async ({ kind, count, response_format }) => {
      const result = generateTestData(kind, count);
      return respond(result, response_format, () =>
        [
          `# ${result.count} generated ${result.kind === "person" ? "person" : "company"} record(s)`,
          "",
          result.kind === "person"
            ? table(
                ["Name", "RFC", "CURP", "CLABE", "Bank", "NSS"],
                result.people.map((p) => [
                  `${p.nombre} ${p.apellido_paterno} ${p.apellido_materno}`,
                  p.rfc,
                  p.curp,
                  p.clabe,
                  p.banco,
                  p.nss,
                ]),
              )
            : table(
                ["Razón social", "RFC", "CLABE", "Bank", "Incorporated"],
                result.companies.map((c) => [c.razon_social, c.rfc, c.clabe, c.banco, c.fecha_constitucion]),
              ),
          "",
          renderFindings(result.findings),
        ].join("\n"),
      );
    },
  );
}
