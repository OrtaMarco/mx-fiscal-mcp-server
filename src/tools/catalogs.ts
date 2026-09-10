/**
 * SAT / Banxico / RENAPO catalogue lookup.
 */

import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { renderFindings, respond, responseFormatField, table } from "../format.js";
import { CATALOG_NAMES, lookupCatalog } from "../core/catalogs.js";
import { CatalogSchema } from "../schemas.js";
import { READ_ONLY } from "./_shared.js";

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "sat_catalog_lookup",
    {
      title: "SAT Catalogue Lookup",
      description: `Look up the code tables a CFDI is written in, without downloading the SAT's spreadsheet. Nine catalogues, all bundled — this tool never touches the network.

  - \`regimen_fiscal\` (c_RegimenFiscal) — tax regime of issuer and receiver
  - \`uso_cfdi\` (c_UsoCFDI) — what the receiver does with the invoice
  - \`forma_pago\` (c_FormaPago) — cash, transfer, card, …
  - \`metodo_pago\` (c_MetodoPago) — PUE vs PPD
  - \`tipo_comprobante\` (c_TipoDeComprobante) — I/E/T/N/P
  - \`objeto_imp\` (c_ObjetoImp) — whether a line item is subject to tax (CFDI 4.0)
  - \`impuestos\` (c_Impuesto) — ISR / IVA / IEPS
  - \`bancos_clabe\` — Banxico participants by the first three CLABE digits
  - \`estados_curp\` — RENAPO's state keys for CURP positions 12-13

With no \`query\` you get the whole catalogue. With one, an exact code match wins (leading zeros are ignored, so '1' finds '01'); failing that it falls back to a case- and accent-insensitive substring search over both code and label, so 'confianza' finds 626 and 'oaxaca' finds OC.

Two honesty notes carried in the output: the bank list is a curated subset of Banxico's participant catalogue rather than the whole thing, and the CURP state keys are RENAPO's own — they do **not** match INEGI or ISO 3166-2:MX codes.

Args:
  - catalog (enum): one of ${CATALOG_NAMES.join(", ")}.
  - query (string, optional): an exact code, or text to search for.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { catalog, official_name, authority, description, used_in, query, match_type, total_entries, match_count, entries[{code, label}], truncated, notes[] }.

Example: "What does UsoCFDI G03 mean?" -> sat_catalog_lookup(catalog="uso_cfdi", query="G03").`,
      inputSchema: z.object({
        catalog: z.enum(CATALOG_NAMES).describe("Which catalogue to read."),
        query: z
          .string()
          .optional()
          .describe("An exact code ('626', 'G03', '012') or free text to search ('confianza', 'BBVA', 'Oaxaca'). Omit for the whole catalogue."),
        response_format: responseFormatField,
      }),
      outputSchema: CatalogSchema,
      annotations: READ_ONLY,
    },
    async ({ catalog, query, response_format }) => {
      const result = lookupCatalog(catalog, query);
      return respond(result, response_format, () =>
        [
          `# ${result.official_name} (${result.authority})`,
          "",
          result.description,
          "",
          `Used in: ${result.used_in}`,
          result.query
            ? `Query \`${result.query}\` → ${result.match_count} of ${result.total_entries} entries (${result.match_type} match)`
            : `${result.total_entries} entries`,
          "",
          result.entries.length
            ? table(["Code", "Meaning"], result.entries.map((e) => [`\`${e.code}\``, e.label]))
            : "_No matching entry._",
          result.truncated ? "\n_Result truncated._" : "",
          "",
          renderFindings(result.notes.map((message) => ({ severity: "info" as const, message }))),
        ].join("\n"),
      );
    },
  );
}
