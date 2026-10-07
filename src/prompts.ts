/**
 * MCP prompts: ready-made starting points that wire the tools together the way
 * the server instructions recommend. Each only builds a user message; none runs
 * anything by itself.
 */

import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "review_cfdi",
    {
      title: "Review a CFDI",
      description: "Read an invoice XML and check it at the SAT, reporting both honestly.",
      argsSchema: z.object({ xml: z.string().describe("The complete CFDI XML.") }),
    },
    ({ xml }) =>
      userMessage(
        `Review this Mexican invoice (CFDI).

1. Call parse_cfdi with the XML and summarise issuer, receiver, concepts, taxes and total, plus every warning or failed check in its findings.
2. Then call cfdi_status with the same XML and report whether the SAT says it is Vigente or Cancelado.

Keep three things straight in your answer: parsing is not verifying (the digital signature is not checked); a structurally valid RFC is not a registered one; and if the SAT could not be reached, say the check was not performed — never call the invoice invalid because of it.

${xml}`,
      ),
  );

  server.registerPrompt(
    "validate_identifiers",
    {
      title: "Validate Mexican identifiers",
      description: "Validate a mixed list of RFC, CURP, CLABE and NSS values, one verdict per value.",
      argsSchema: z.object({
        values: z.string().describe("The identifiers to check, one per line or separated by commas."),
      }),
    },
    ({ values }) =>
      userMessage(
        `Work out which kind each of these Mexican identifiers is (RFC 12-13 characters, CURP 18 characters, CLABE 18 digits, NSS 11 digits) and validate each with the matching tool: validate_rfc, validate_curp, validate_clabe or validate_nss. Give one line per value with its verdict and the reason for any failure. If a value could be two kinds, say so and validate it as both. Say 'structurally valid', never 'registered' or 'real'; for XAXX010101000 say whether you mean it is the SAT's generic or whether it satisfies the check digit (it does not).

${values}`,
      ),
  );

  server.registerPrompt(
    "seed_test_data",
    {
      title: "Seed fixtures with valid Mexican data",
      description: "Generate fake but check-digit-valid people or companies for a seed file or test.",
      argsSchema: z.object({
        count: z.string().describe("How many records, 1-100.").optional(),
        kind: z.string().describe("'person' (default) or 'company'.").optional(),
      }),
    },
    ({ count, kind }) =>
      userMessage(
        `Call generate_test_data with kind="${kind === "company" ? "company" : "person"}" and count=${Math.min(100, Math.max(1, Number.parseInt(count ?? "5", 10) || 5))}, then lay the records out in the format I ask for next (JSON, CSV or SQL inserts). Remind me that they pass validation but are not real records and must not be sent to the SAT or a PAC.`,
      ),
  );
}
