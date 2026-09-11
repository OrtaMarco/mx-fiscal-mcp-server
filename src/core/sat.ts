/**
 * Client for the SAT's public CFDI status service (`ConsultaCFDIService.svc`).
 *
 * This is the same web service the QR code on every printed Mexican invoice
 * points at, so it needs no credentials, no CSD and no PAC contract. What it
 * does need is care: the SAT publishes no rate limit, no SLA and no uptime
 * page, and the endpoint goes down. Every failure path here degrades to
 * `available: false` with a reason — a tool that throws would make an agent
 * report "the invoice is invalid" when the truth is "the SAT did not answer".
 *
 * The envelope, the SOAPAction and the result element name were read from
 * nodecfdi/sat-estado-cfdi (MIT) rather than guessed:
 *   - src/utils/constants.ts            → URL, SoapAction, namespaces
 *   - src/clients/internal/soap_xml.ts  → s:Envelope > s:Body > c:Consulta > c:expresionImpresa
 *   - src/clients/fetch_consumer_client.ts → Content-Type + SOAPAction headers
 *   - src/utils/cfdi_status_builder.ts  → the meaning of each returned string
 * The `tt` formatting rule comes from nodecfdi/cfdi-expresiones
 * (src/extractors/standards/format_total18x6.ts).
 */

import { DOMParser } from "@xmldom/xmldom";
import {
  SAT_CONSULTA_URL,
  SAT_RETRIES,
  SAT_RETRY_DELAY_MS,
  SAT_SOAP_ACTION,
  SAT_SOAP_NS,
  SAT_TIMEOUT_MS,
  SOAP_ENVELOPE_NS,
  USER_AGENT,
} from "../constants.js";
import type { Finding } from "../format.js";

// --- expression -------------------------------------------------------------

/**
 * Format the total the way the printed-representation spec demands: six
 * decimals, trailing zeros trimmed, and at least one decimal kept.
 * 1160 → "1160.0"; 1234.56 → "1234.56".
 */
export function formatExpressionTotal(total: string): string {
  const n = Number(total);
  if (!Number.isFinite(n)) return total;
  let out = n.toFixed(6).replace(/0+$/, "");
  if (out.endsWith(".")) out += "0";
  return out;
}

/** Build the `expresionImpresa` the service expects. */
/**
 * RFCs may contain '&' (e.g. «Ñ&A…»). The printed-representation expression
 * carries it as '&amp;' — nodecfdi does the same — and it has to be encoded
 * before upper-casing, or an already-encoded '&amp;' would become '&AMP;'.
 */
export function expressionRfc(rfc: string): string {
  return rfc.trim().replace(/&amp;/gi, "&").toUpperCase().replace(/&/g, "&amp;");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_SHAPE_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const TOTAL_RE = /^\d{1,18}(?:\.\d{1,6})?$/;

/**
 * Screen the four query values before spending a request on them. Only the
 * *shape* is checked: a generic RFC like XAXX010101000 fails its own check digit
 * yet appears on real invoices, so check digits are not enforced here.
 * @returns one message per problem; empty when the query can be sent.
 */
export function validateStatusQuery(input: {
  rfc_emisor: string;
  rfc_receptor: string;
  total: string;
  uuid: string;
}): string[] {
  const problems: string[] = [];
  for (const [field, value] of [
    ["rfc_emisor", input.rfc_emisor],
    ["rfc_receptor", input.rfc_receptor],
  ] as const) {
    if (!RFC_SHAPE_RE.test(value.trim().replace(/&amp;/gi, "&"))) {
      problems.push(`${field} '${value}' is not shaped like an RFC (12 or 13 characters: letters, six-digit date, three-character homoclave).`);
    }
  }
  if (!TOTAL_RE.test(input.total.trim())) {
    problems.push(`total '${input.total}' must be a plain decimal exactly as written in the XML, e.g. '1160.00' — no thousands separators, signs or currency symbols.`);
  }
  if (!UUID_RE.test(input.uuid.trim())) {
    problems.push(`uuid '${input.uuid}' is not a UUID (8-4-4-4-12 hexadecimal digits).`);
  }
  return problems;
}

export function buildExpression(input: {
  rfc_emisor: string;
  rfc_receptor: string;
  total: string;
  uuid: string;
}): string {
  return (
    `?re=${expressionRfc(input.rfc_emisor)}` +
    `&rr=${expressionRfc(input.rfc_receptor)}` +
    `&tt=${formatExpressionTotal(input.total)}` +
    `&id=${input.uuid.trim().toUpperCase()}`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The exact SOAP 1.1 envelope the WCF service accepts. */
export function buildSoapEnvelope(expression: string): string {
  return (
    `<s:Envelope xmlns:s="${SOAP_ENVELOPE_NS}">` +
    `<s:Body>` +
    `<c:Consulta xmlns:c="${SAT_SOAP_NS}">` +
    `<c:expresionImpresa>${escapeXml(expression)}</c:expresionImpresa>` +
    `</c:Consulta>` +
    `</s:Body>` +
    `</s:Envelope>`
  );
}

// --- response ---------------------------------------------------------------

/** Pull the children of `<ConsultaResult>` into a flat record. */
export function extractConsultaResult(xml: string): Record<string, string> {
  if (!xml.trim()) return {};
  let doc;
  try {
    doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, "text/xml");
  } catch {
    return {};
  }
  const nodes = doc.getElementsByTagNameNS(SAT_SOAP_NS, "ConsultaResult");
  const result = nodes.item(0);
  if (!result) return {};
  const out: Record<string, string> = {};
  for (const node of Array.from(result.childNodes)) {
    const el = node as unknown as { nodeType: number; localName?: string; textContent?: string };
    if (el.nodeType !== 1 || !el.localName) continue;
    out[el.localName] = el.textContent ?? "";
  }
  return out;
}

// --- interpretation ---------------------------------------------------------

export type QueryOutcome = "found" | "not_found";
export type DocumentState = "vigente" | "cancelado" | "no_encontrado";
export type CancellableState = "sin_aceptacion" | "con_aceptacion" | "no_cancelable" | "unknown";
export type CancellationState =
  | "cancelado_sin_aceptacion"
  | "cancelado_con_aceptacion"
  | "plazo_vencido"
  | "en_proceso"
  | "solicitud_rechazada"
  | "ninguno";
export type EfosState = "not_listed" | "listed" | "unknown";

export interface SatStatusReading {
  codigo_estatus: string;
  query_outcome: QueryOutcome;
  estado: string;
  document_state: DocumentState;
  document_meaning: string;
  es_cancelable: string;
  cancellable_state: CancellableState;
  cancellable_meaning: string;
  estatus_cancelacion: string;
  cancellation_state: CancellationState;
  cancellation_meaning: string;
  validacion_efos: string;
  efos_state: EfosState;
  efos_meaning: string;
  raw: Record<string, string>;
}

const DOCUMENT_MEANING: Record<DocumentState, string> = {
  vigente: "The invoice exists in the SAT's records and has not been cancelled.",
  cancelado: "The invoice exists but has been cancelled. It cannot be deducted.",
  no_encontrado:
    "The SAT has no invoice matching this issuer RFC, receiver RFC, total and UUID. Either one of the four values is wrong, or the document was never stamped.",
};

const CANCELLABLE_MEANING: Record<CancellableState, string> = {
  sin_aceptacion:
    "Cancelable sin aceptación: the issuer may cancel it unilaterally (typically because it is under $1,000 MXN, has no related documents, or falls under one of the SAT's listed exceptions).",
  con_aceptacion:
    "Cancelable con aceptación: the issuer must request cancellation and the receiver has 72 hours to accept or reject; silence counts as acceptance.",
  no_cancelable:
    "No cancelable: the invoice cannot be cancelled — usually because it already has a related payment or transfer document.",
  unknown: "The service returned no cancellability value for this document.",
};

const CANCELLATION_MEANING: Record<CancellationState, string> = {
  cancelado_sin_aceptacion: "It was cancelled unilaterally by the issuer.",
  cancelado_con_aceptacion: "It was cancelled and the receiver accepted the request.",
  plazo_vencido: "It was cancelled because the receiver let the 72-hour window lapse without answering.",
  en_proceso: "A cancellation request is open and awaiting the receiver's answer.",
  solicitud_rechazada: "The receiver rejected the cancellation request, so the invoice is still live.",
  ninguno: "No cancellation process has been started for this invoice.",
};

/** Map the service's Spanish strings onto stable states. */
export function interpret(values: Record<string, string>): SatStatusReading {
  const get = (key: string): string => values[key] ?? "";
  const codigo = get("CodigoEstatus");
  const estado = get("Estado");
  const cancelable = get("EsCancelable");
  const cancelacion = get("EstatusCancelacion");
  // The field was added in late 2020 and both spellings appear in the wild.
  const efos = values["ValidacionEFOS"] ?? values["VerificacionEFOS"] ?? "";

  const documentState: DocumentState =
    estado === "Vigente" ? "vigente" : estado === "Cancelado" ? "cancelado" : "no_encontrado";

  const cancellableState: CancellableState =
    cancelable === "Cancelable sin aceptación"
      ? "sin_aceptacion"
      : cancelable === "Cancelable con aceptación"
        ? "con_aceptacion"
        : cancelable === "No cancelable"
          ? "no_cancelable"
          : cancelable
            ? "unknown"
            : "unknown";

  const cancellationState: CancellationState =
    cancelacion === "Cancelado sin aceptación"
      ? "cancelado_sin_aceptacion"
      : cancelacion === "Cancelado con aceptación"
        ? "cancelado_con_aceptacion"
        : cancelacion === "Plazo vencido"
          ? "plazo_vencido"
          : cancelacion === "En proceso"
            ? "en_proceso"
            : cancelacion === "Solicitud rechazada"
              ? "solicitud_rechazada"
              : "ninguno";

  // 200/201 mean the issuer is NOT on the definitive 69-B (EFOS) list. The SAT
  // does not publish the code table; this mapping is the one phpcfdi and
  // nodecfdi both use, and it is reported as an interpretation, not a fact.
  // An empty field is NOT evidence of anything — the SAT returns it blank on a
  // 'No Encontrado', and the field itself only exists since late 2020.
  const efosState: EfosState = !efos ? "unknown" : efos === "200" || efos === "201" ? "not_listed" : "listed";

  return {
    codigo_estatus: codigo,
    query_outcome: codigo.startsWith("S - ") ? "found" : "not_found",
    estado,
    document_state: documentState,
    document_meaning: DOCUMENT_MEANING[documentState],
    es_cancelable: cancelable,
    cancellable_state: cancellableState,
    cancellable_meaning: CANCELLABLE_MEANING[cancellableState],
    estatus_cancelacion: cancelacion,
    cancellation_state: cancellationState,
    cancellation_meaning: CANCELLATION_MEANING[cancellationState],
    validacion_efos: efos,
    efos_state: efosState,
    efos_meaning: efos
      ? efosState === "not_listed"
        ? `EFOS check returned ${efos}: the issuer is NOT on the SAT's definitive 69-B list of companies that invoice simulated operations.`
        : `EFOS check returned ${efos}, which is neither 200 nor 201 — under the mapping phpcfdi and nodecfdi use, that means the issuer IS on the SAT's definitive 69-B list. Verify against the published 69-B list before acting on it: the SAT documents neither the code table nor this field.`
      : "The service returned no EFOS field for this query (the field was added in late 2020 and is not always populated).",
    raw: values,
  };
}

// --- transport --------------------------------------------------------------

export interface SatStatusResult {
  available: boolean;
  /** Why the SAT could not be reached. `null` when `available` is true. */
  unavailable_reason: string | null;
  endpoint: string;
  expression: string;
  attempts: number;
  elapsed_ms: number;
  status: SatStatusReading | null;
  findings: Finding[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(expression: string): Promise<Record<string, string>> {
  const response = await fetch(SAT_CONSULTA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: SAT_SOAP_ACTION,
      "User-Agent": USER_AGENT,
    },
    body: buildSoapEnvelope(expression),
    signal: AbortSignal.timeout(SAT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `the SAT answered HTTP ${response.status} ${response.statusText}${
        text.trim() ? ` — ${text.trim().slice(0, 200)}` : ""
      }`,
    );
  }
  const values = extractConsultaResult(text);
  if (Object.keys(values).length === 0) {
    throw new Error(
      `the SAT answered 200 but the body carried no <ConsultaResult> element${
        text.trim() ? ` — ${text.trim().slice(0, 200)}` : " (empty body)"
      }`,
    );
  }
  return values;
}

/**
 * Query the SAT. Never throws: transport failures come back as
 * `available: false` with the reason spelled out.
 */
export async function queryCfdiStatus(input: {
  rfc_emisor: string;
  rfc_receptor: string;
  total: string;
  uuid: string;
}): Promise<SatStatusResult> {
  const expression = buildExpression(input);
  const began = Date.now();
  let lastError = "";

  for (let tries = 0; tries <= SAT_RETRIES; tries++) {
    if (tries > 0) await sleep(SAT_RETRY_DELAY_MS);
    try {
      const values = await attempt(expression);
      const status = interpret(values);
      const findings: Finding[] = [];

      if (status.document_state === "vigente") {
        findings.push({ severity: "pass", message: status.document_meaning });
      } else if (status.document_state === "cancelado") {
        findings.push({ severity: "warn", message: status.document_meaning });
      } else {
        findings.push({ severity: "fail", message: status.document_meaning });
        findings.push({
          severity: "info",
          message:
            "'No Encontrado' most often means the total was formatted differently from the way the SAT stores it, or the UUID was mistyped — not that the invoice is fake. Re-derive the four values from the XML (pass `xml` instead of the four fields) before concluding anything.",
        });
      }
      if (status.efos_state === "listed" && status.validacion_efos) {
        findings.push({ severity: "warn", message: status.efos_meaning });
      }
      findings.push({
        severity: "info",
        message:
          "The SAT publishes no rate limit and no SLA for this endpoint. Query it once per invoice, cache the answer, and never put it in a hot loop.",
      });

      return {
        available: true,
        unavailable_reason: null,
        endpoint: SAT_CONSULTA_URL,
        expression,
        attempts: tries + 1,
        elapsed_ms: Date.now() - began,
        status,
        findings,
      };
    } catch (err) {
      lastError = describe(err);
    }
  }

  return {
    available: false,
    unavailable_reason: lastError,
    endpoint: SAT_CONSULTA_URL,
    expression,
    attempts: SAT_RETRIES + 1,
    elapsed_ms: Date.now() - began,
    status: null,
    findings: [
      {
        severity: "warn",
        message: `The SAT status service could not be reached: ${lastError}`,
      },
      {
        severity: "info",
        message:
          "This is a statement about the SAT, not about the invoice. Do NOT report the document as invalid, cancelled or non-existent on the strength of an unreachable service — say the check could not be performed and try again later.",
      },
    ],
  };
}

function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 4; depth++) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? (current.cause ?? null) : null;
  }
  const message = parts.join(" | ");
  if (/TimeoutError|aborted|timeout/i.test(message)) {
    return `the request timed out after ${SAT_TIMEOUT_MS} ms (${message})`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `the hostname could not be resolved — this machine may have no outbound DNS (${message})`;
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(message)) {
    return `the connection was refused or reset by the SAT (${message})`;
  }
  if (/certificate|SSL|TLS/i.test(message)) {
    return `the TLS handshake with the SAT failed (${message})`;
  }
  return message;
}
