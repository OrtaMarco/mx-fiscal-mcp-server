/**
 * Shared constants for the Mexican fiscal MCP server.
 */

export const SERVER_NAME = "mx-fiscal-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum size of any tool response, in characters, before truncation. */
export const CHARACTER_LIMIT = 25_000;

/**
 * The ONLY external host this server ever contacts: the SAT's public CFDI status
 * web service (the same endpoint behind the QR code printed on every Mexican
 * invoice). It is a hardcoded constant on purpose — no tool accepts a URL from
 * the caller, so there is no SSRF surface to guard.
 *
 * Source: https://www.sat.gob.mx/consultas/20585/conoce-los-servicios-especializados-de-validacion
 */
export const SAT_CONSULTA_URL =
  "https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc";

/** SAT's own sandbox endpoint for the same service, kept for reference only. */
export const SAT_CONSULTA_URL_SANDBOX =
  "https://pruebacfdiconsultaqr.cloudapp.net/ConsultaCFDIService.svc";

/** SOAPAction header required by the WCF service. */
export const SAT_SOAP_ACTION = "http://tempuri.org/IConsultaCFDIService/Consulta";

/** Namespace of the service contract (`Consulta` / `expresionImpresa` / `ConsultaResult`). */
export const SAT_SOAP_NS = "http://tempuri.org/";

/** SOAP 1.1 envelope namespace. */
export const SOAP_ENVELOPE_NS = "http://schemas.xmlsoap.org/soap/envelope/";

/** Per-request timeout against the SAT, in milliseconds. */
export const SAT_TIMEOUT_MS = 10_000;

/** How many times the SAT request is retried after a failure (one retry = two attempts). */
export const SAT_RETRIES = 1;

/** Pause between the failed attempt and the retry, in milliseconds. */
export const SAT_RETRY_DELAY_MS = 750;

/** User agent sent to the SAT. Identifies the client honestly. */
export const USER_AGENT =
  "mx-fiscal-mcp-server/1.0 (+https://ortamarco.me; MCP CFDI status reader)";

/** Largest CFDI XML we will parse, in characters. Guards against runaway input. */
export const MAX_XML_CHARS = 4_000_000;

/** Upper bound on `generate_test_data`'s `count`. */
export const MAX_GENERATED_RECORDS = 100;
