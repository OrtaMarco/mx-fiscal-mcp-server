/**
 * CFDI tools: read the XML, and ask the SAT whether the document is live.
 */

import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { fail, field, renderFindings, respond, responseFormatField, table } from "../format.js";
import { CfdiParseError, parseCfdi } from "../core/cfdi.js";
import { queryCfdiStatus, validateStatusQuery } from "../core/sat.js";
import { CfdiSchema, CfdiStatusSchema } from "../schemas.js";
import { SAT_CONSULTA_URL } from "../constants.js";
import { READ_ONLY, READ_ONLY_NETWORK, withHeavySlot } from "./_shared.js";

const xmlField = z
  .string()
  .min(1)
  .describe("The complete CFDI XML as a string, from '<cfdi:Comprobante' (or '<?xml') to the closing tag.");

export function registerCfdiTools(server: McpServer): void {
  // --- parse_cfdi ----------------------------------------------------------

  server.registerTool(
    "parse_cfdi",
    {
      title: "Parse CFDI 4.0 XML",
      description: `Turn the XML of a Mexican electronic invoice (CFDI 4.0) into structured JSON: header, issuer, receiver, every line item with its transferred and withheld taxes, the tax totals, and the Timbre Fiscal Digital (UUID, stamp date, SAT certificate number, PAC's RFC) — or \`timbre: null\` when the document was never stamped.

Three things this does beyond reading attributes:

  1. **It labels the catalogue codes.** '601' becomes 'General de Ley Personas Morales', 'G03' becomes 'Gastos en general', 'PPD' becomes 'Pago en parcialidades o diferido'. An unknown code is reported as unknown rather than guessed at.
  2. **It validates both RFCs** (issuer and receiver) with the full modulus-11 check, and flags the SAT generics.
  3. **It checks the arithmetic**: subtotal − discount + transferred − withheld should equal the declared total. A mismatch is a warning, not a verdict — rounding at the line level is allowed within a centavo.

It walks the document by local element name, so it does not care whether the PAC used the \`cfdi:\` and \`tfd:\` prefixes, different ones, or none.

**What this does NOT do:** it does not verify the digital signature, and it does not ask the SAT anything. A document that parses cleanly can still be cancelled, or have been fabricated wholesale. Use \`cfdi_status\` for the SAT's own answer.

Args:
  - xml (string): the CFDI XML.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { version, serie, folio, fecha, tipo(+label), forma_pago(+label), metodo_pago(+label), moneda, tipo_cambio, sub_total, descuento, total, lugar_expedicion, exportacion, condiciones_de_pago, no_certificado, emisor{rfc, nombre, regimen(+label), rfc_valid, rfc_kind, rfc_errors}, receptor{… domicilio, uso(+label)}, conceptos[{descripcion, clave_prod_serv, cantidad, clave_unidad, unidad, valor_unitario, importe, descuento, objeto_imp(+label), traslados[], retenciones[]}], concepto_count, total_trasladados, total_retenidos, stamped, timbre{uuid, fecha_timbrado, no_certificado_sat, rfc_prov_certif} | null, arithmetic{…}, findings[] }.

Example: "Read this invoice and tell me who issued it and for how much" -> parse_cfdi(xml="<cfdi:Comprobante …>").`,
      inputSchema: z.object({ xml: xmlField, response_format: responseFormatField }),
      outputSchema: CfdiSchema,
      annotations: READ_ONLY,
    },
    async ({ xml, response_format }) =>
      withHeavySlot(async () => {
        let doc;
        try {
          doc = parseCfdi(xml);
        } catch (err) {
          if (err instanceof CfdiParseError) return fail(`Error: ${err.message}`);
          return fail(`Error reading the CFDI: ${err instanceof Error ? err.message : String(err)}`);
        }

        return respond(doc, response_format, () =>
          [
            `# CFDI ${doc.serie}${doc.folio ? `-${doc.folio}` : ""} — ${doc.total} ${doc.moneda}`,
            "",
            `${doc.stamped ? "✅ Stamped" : "⚠️ Unstamped"} · version ${doc.version || "?"} · ${doc.tipo_label ?? doc.tipo}`,
            "",
            "## Comprobante",
            field("Issued", doc.fecha),
            field("Type", doc.tipo_label ? `${doc.tipo} — ${doc.tipo_label}` : doc.tipo),
            field("Payment form", doc.forma_pago_label ? `${doc.forma_pago} — ${doc.forma_pago_label}` : doc.forma_pago),
            field(
              "Payment method",
              doc.metodo_pago_label ? `${doc.metodo_pago} — ${doc.metodo_pago_label}` : doc.metodo_pago,
            ),
            field("Currency", doc.tipo_cambio ? `${doc.moneda} (rate ${doc.tipo_cambio})` : doc.moneda),
            field("Issued at postcode", doc.lugar_expedicion),
            "",
            "## Emisor",
            field("RFC", `${doc.emisor.rfc} ${doc.emisor.rfc_valid ? "✅" : "❌"}`),
            field("Name", doc.emisor.nombre),
            field(
              "Regime",
              doc.emisor.regimen_label ? `${doc.emisor.regimen} — ${doc.emisor.regimen_label}` : doc.emisor.regimen,
            ),
            "",
            "## Receptor",
            field("RFC", `${doc.receptor.rfc} ${doc.receptor.rfc_valid ? "✅" : "❌"}`),
            field("Name", doc.receptor.nombre),
            field("Tax address (postcode)", doc.receptor.domicilio),
            field(
              "Regime",
              doc.receptor.regimen_label
                ? `${doc.receptor.regimen} — ${doc.receptor.regimen_label}`
                : doc.receptor.regimen,
            ),
            field("CFDI use", doc.receptor.uso_label ? `${doc.receptor.uso} — ${doc.receptor.uso_label}` : doc.receptor.uso),
            "",
            `## Conceptos (${doc.concepto_count}${doc.conceptos_truncated ? `, first ${doc.conceptos.length} shown` : ""})`,
            table(
              ["Description", "Qty", "Unit price", "Amount", "Taxes"],
              doc.conceptos.map((c) => [
                c.descripcion.slice(0, 60),
                c.cantidad,
                c.valor_unitario,
                c.importe,
                [
                  ...c.traslados.map((t) => `+${t.impuesto_label ?? t.impuesto} ${t.importe}`),
                  ...c.retenciones.map((r) => `−${r.impuesto_label ?? r.impuesto} ${r.importe}`),
                ].join(", ") || "—",
              ]),
            ),
            "",
            "## Totals",
            field("Subtotal", doc.sub_total),
            field("Discount", doc.descuento),
            field("Transferred taxes", doc.total_trasladados),
            field("Withheld taxes", doc.total_retenidos),
            field("Total", doc.total),
            "",
            "## Timbre fiscal digital",
            ...(doc.timbre
              ? [
                  field("UUID", doc.timbre.uuid),
                  field("Stamped at", doc.timbre.fecha_timbrado),
                  field("SAT certificate", doc.timbre.no_certificado_sat),
                  field("PAC RFC", doc.timbre.rfc_prov_certif),
                ]
              : ["- The document carries no Timbre Fiscal Digital."]),
            "",
            renderFindings(doc.findings),
          ].join("\n"),
        );
      }),
  );

  // --- cfdi_status ---------------------------------------------------------

  server.registerTool(
    "cfdi_status",
    {
      title: "CFDI Status at the SAT",
      description: `Ask the SAT whether an invoice actually exists and is still live. This queries the public \`ConsultaCFDIService\` SOAP endpoint — the same service the QR code printed on every Mexican invoice points at — so it needs **no credentials, no CSD and no PAC contract**.

Pass either the four values the SAT keys on (issuer RFC, receiver RFC, total, UUID) or the whole \`xml\`, in which case they are derived from it with the same reader \`parse_cfdi\` uses. Deriving them from the XML is the more reliable route: the total must be formatted exactly the way the printed-representation spec demands (six decimals, trailing zeros trimmed), and a hand-typed total is the single most common cause of a spurious 'No Encontrado'.

What comes back, each with its meaning spelled out:

  - **Estado** — Vigente / Cancelado / No Encontrado.
  - **EsCancelable** — whether the issuer can cancel it unilaterally, needs the receiver's approval, or cannot cancel it at all.
  - **EstatusCancelacion** — whether a cancellation is in progress, was accepted, was rejected, or lapsed.
  - **ValidacionEFOS** — whether the issuer appears on the SAT's definitive 69-B list of companies that invoice simulated operations.
  - **CodigoEstatus** — the service's own result code.

**Fail-soft by design.** The SAT publishes no rate limit, no SLA and no status page, and the endpoint does go down. On timeout, refusal or a malformed answer this returns \`available: false\` with the reason instead of raising — a failed lookup is a statement about the SAT, never about the invoice. Never report a document as invalid on the strength of an unreachable service. One retry, 10-second timeout.

Args (either shape):
  - xml (string), OR rfc_emisor + rfc_receptor + total + uuid (all strings).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { available, unavailable_reason, endpoint, expression, attempts, elapsed_ms, source, status{codigo_estatus, query_outcome, estado, document_state, document_meaning, es_cancelable, cancellable_state, cancellable_meaning, estatus_cancelacion, cancellation_state, cancellation_meaning, validacion_efos, efos_state, efos_meaning, raw} | null, findings[] }.

Example: "Is this invoice still valid?" -> cfdi_status(xml="<cfdi:Comprobante …>").`,
      inputSchema: z.object({
        xml: z
          .string()
          .optional()
          .describe(
            "The complete CFDI XML. When given, the four query fields are derived from it and any values passed alongside are ignored.",
          ),
        rfc_emisor: z.string().optional().describe("Issuer's RFC. Required unless `xml` is given."),
        rfc_receptor: z.string().optional().describe("Receiver's RFC. Required unless `xml` is given."),
        total: z
          .string()
          .optional()
          .describe("Invoice total exactly as written in the XML, e.g. '1160.00'. Required unless `xml` is given."),
        uuid: z
          .string()
          .optional()
          .describe("The fiscal folio (UUID) from the Timbre Fiscal Digital. Required unless `xml` is given."),
        response_format: responseFormatField,
      }),
      outputSchema: CfdiStatusSchema,
      annotations: READ_ONLY_NETWORK,
    },
    async ({ xml, rfc_emisor, rfc_receptor, total, uuid, response_format }) =>
      withHeavySlot(async () => {
        let source: "fields" | "xml" = "fields";
        let query: { rfc_emisor: string; rfc_receptor: string; total: string; uuid: string };

        if (xml && xml.trim()) {
          source = "xml";
          let doc;
          try {
            doc = parseCfdi(xml);
          } catch (err) {
            if (err instanceof CfdiParseError) return fail(`Error: ${err.message}`);
            return fail(`Error reading the CFDI: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (!doc.timbre?.uuid) {
            return fail(
              "Error: this CFDI carries no Timbre Fiscal Digital, so it has no UUID and the SAT has no record of it. An unstamped XML cannot be looked up.",
            );
          }
          query = {
            rfc_emisor: doc.emisor.rfc,
            rfc_receptor: doc.receptor.rfc,
            total: doc.total,
            uuid: doc.timbre.uuid,
          };
        } else {
          const missing = [
            ["rfc_emisor", rfc_emisor],
            ["rfc_receptor", rfc_receptor],
            ["total", total],
            ["uuid", uuid],
          ]
            .filter(([, v]) => !v || !String(v).trim())
            .map(([k]) => k);
          if (missing.length > 0) {
            return fail(
              `Error: missing ${missing.join(", ")}. Pass either the whole invoice as \`xml\`, or all four of rfc_emisor, rfc_receptor, total and uuid.`,
            );
          }
          query = {
            rfc_emisor: rfc_emisor as string,
            rfc_receptor: rfc_receptor as string,
            total: total as string,
            uuid: uuid as string,
          };
          const problems = validateStatusQuery(query);
          if (problems.length > 0) {
            return fail(`Error: not sent to the SAT, because the query would come back 'No Encontrado' for the wrong reason:\n- ${problems.join("\n- ")}`);
          }
        }

        const result = await queryCfdiStatus(query);
        const payload = { ...result, source };

        return respond(payload, response_format, () => {
          if (!payload.available || !payload.status) {
            return [
              `# CFDI status — unavailable`,
              "",
              `⚠️ The SAT service could not be reached after ${payload.attempts} attempt(s) in ${payload.elapsed_ms} ms.`,
              "",
              field("Reason", payload.unavailable_reason),
              field("Endpoint", payload.endpoint),
              field("Expression sent", payload.expression),
              "",
              renderFindings(payload.findings),
            ].join("\n");
          }
          const s = payload.status;
          return [
            `# CFDI status — ${s.estado || "(no state returned)"}`,
            "",
            `${s.document_state === "vigente" ? "✅" : s.document_state === "cancelado" ? "⚠️" : "❌"} ${s.document_meaning}`,
            "",
            field("UUID queried", query.uuid.toUpperCase()),
            field("Códigos de estatus", s.codigo_estatus),
            field("Es cancelable", s.es_cancelable || "—"),
            field("Estatus de cancelación", s.estatus_cancelacion || "—"),
            field("Validación EFOS", s.validacion_efos || "—"),
            field("Expression sent", payload.expression),
            field("Answered in", `${payload.elapsed_ms} ms (${payload.attempts} attempt(s))`),
            "",
            "## What each field means",
            `- **Cancellability:** ${s.cancellable_meaning}`,
            `- **Cancellation:** ${s.cancellation_meaning}`,
            `- **EFOS:** ${s.efos_meaning}`,
            "",
            renderFindings(payload.findings),
            "",
            `_Source: ${SAT_CONSULTA_URL} (public, no credentials)._`,
          ].join("\n");
        });
      }),
  );
}
