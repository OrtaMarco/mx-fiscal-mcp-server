/**
 * CFDI 4.0 reader.
 *
 * `parseCfdi()` below is a 1:1 port of the browser tool that ships at
 * https://ortamarco.me/herramientas/lector-cfdi/ (src/components/tools/data/CfdiViewer.tsx).
 * It walks the document by `localName`, so it never depends on the `cfdi:` /
 * `tfd:` prefixes actually used by the PAC that stamped the invoice — some
 * stamp with no prefix at all, some with their own. `@xmldom/xmldom` supplies
 * the `DOMParser` the browser gave the original for free.
 *
 * Nothing here validates the digital signature or contacts the SAT: this reads
 * what the XML says. `cfdi_status` is the tool that asks the SAT whether the
 * document is actually live.
 */

import { DOMParser } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";
import {
  CFDI_FORMA_PAGO,
  CFDI_IMPUESTOS,
  CFDI_METODO_PAGO,
  CFDI_OBJETO_IMP,
  CFDI_REGIMEN,
  CFDI_TIPO,
  CFDI_USO,
} from "mx-identifiers";
import { MAX_XML_CHARS } from "../constants.js";
import type { Finding } from "../format.js";
import { reportRfc } from "./identifiers.js";

// --- shape ------------------------------------------------------------------

export interface CfdiImpuesto {
  base: string;
  impuesto: string;
  impuesto_label: string | null;
  tipo_factor: string;
  tasa_o_cuota: string;
  importe: string;
}

export interface CfdiConcepto {
  descripcion: string;
  clave_prod_serv: string;
  cantidad: string;
  clave_unidad: string;
  unidad: string;
  valor_unitario: string;
  importe: string;
  descuento: string;
  objeto_imp: string;
  objeto_imp_label: string | null;
  traslados: CfdiImpuesto[];
  retenciones: CfdiImpuesto[];
}

export interface CfdiParty {
  rfc: string;
  nombre: string;
  regimen: string;
  regimen_label: string | null;
  rfc_valid: boolean;
  rfc_kind: string | null;
  rfc_errors: string[];
}

export interface CfdiTimbre {
  uuid: string;
  fecha_timbrado: string;
  no_certificado_sat: string;
  rfc_prov_certif: string;
}

export interface CfdiDocument {
  version: string;
  serie: string;
  folio: string;
  fecha: string;
  tipo: string;
  tipo_label: string | null;
  forma_pago: string;
  forma_pago_label: string | null;
  metodo_pago: string;
  metodo_pago_label: string | null;
  moneda: string;
  tipo_cambio: string;
  sub_total: string;
  descuento: string;
  total: string;
  lugar_expedicion: string;
  exportacion: string;
  condiciones_de_pago: string;
  no_certificado: string;
  emisor: CfdiParty;
  receptor: CfdiParty & { domicilio: string; uso: string; uso_label: string | null };
  conceptos: CfdiConcepto[];
  concepto_count: number;
  total_trasladados: string;
  total_retenidos: string;
  stamped: boolean;
  timbre: CfdiTimbre | null;
  arithmetic: {
    declared_total: string;
    computed_total: string | null;
    matches: boolean | null;
    difference: string | null;
  };
  findings: Finding[];
}

/** Thrown when the input is not parseable XML, or is XML but not a CFDI. */
export class CfdiParseError extends Error {
  constructor(
    message: string,
    public readonly reason: "too_large" | "parse" | "not_cfdi",
  ) {
    super(message);
    this.name = "CfdiParseError";
  }
}

// --- DOM helpers (ported verbatim) ------------------------------------------

/** A direct child with that local name, ignoring the namespace prefix. */
function child(el: Element | null, localName: string): Element | null {
  if (!el) return null;
  for (const node of Array.from(el.childNodes)) {
    const candidate = node as unknown as Element;
    if (candidate.nodeType === 1 && candidate.localName === localName) return candidate;
  }
  return null;
}

/** Every descendant with that local name, prefix-independent. */
function descendants(el: Element | null, localName: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagName("*")).filter((n) => n.localName === localName);
}

/** Direct element children, in document order. */
function elementChildren(el: Element | null): Element[] {
  if (!el) return [];
  return Array.from(el.childNodes)
    .map((n) => n as unknown as Element)
    .filter((n) => n.nodeType === 1);
}

function attr(el: Element | null, name: string): string {
  return el?.getAttribute(name) ?? "";
}

function label(code: string, catalog: Record<string, string>): string | null {
  if (!code) return null;
  return catalog[code] ?? null;
}

function readImpuestos(
  parent: Element | null,
  group: "Traslados" | "Retenciones",
  single: "Traslado" | "Retencion",
): CfdiImpuesto[] {
  const container = child(parent, group);
  if (!container) return [];
  return elementChildren(container)
    .filter((n) => n.localName === single)
    .map((n) => ({
      base: attr(n, "Base"),
      impuesto: attr(n, "Impuesto"),
      impuesto_label: label(attr(n, "Impuesto"), CFDI_IMPUESTOS),
      tipo_factor: attr(n, "TipoFactor"),
      tasa_o_cuota: attr(n, "TasaOCuota"),
      importe: attr(n, "Importe"),
    }));
}

// --- arithmetic -------------------------------------------------------------

function num(value: string): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * subTotal − descuento + trasladados − retenidos should equal total. A CFDI
 * whose numbers do not add up is not necessarily invalid (rounding at the
 * concepto level is allowed within a centavo), so a mismatch is a warning, not
 * a failure.
 */
function checkArithmetic(doc: {
  sub_total: string;
  descuento: string;
  total: string;
  total_trasladados: string;
  total_retenidos: string;
}): CfdiDocument["arithmetic"] {
  const subTotal = num(doc.sub_total);
  const total = num(doc.total);
  if (subTotal === null || total === null) {
    return { declared_total: doc.total, computed_total: null, matches: null, difference: null };
  }
  const computed =
    subTotal - (num(doc.descuento) ?? 0) + (num(doc.total_trasladados) ?? 0) - (num(doc.total_retenidos) ?? 0);
  const difference = total - computed;
  return {
    declared_total: doc.total,
    computed_total: computed.toFixed(2),
    matches: Math.abs(difference) < 0.011,
    difference: difference.toFixed(2),
  };
}

// --- parse ------------------------------------------------------------------

/**
 * Read a CFDI XML string into a plain object. Throws `CfdiParseError` when the
 * input is not XML, or is XML whose root element is not `Comprobante`.
 */
export function parseCfdi(xml: string): CfdiDocument {
  if (xml.length > MAX_XML_CHARS) {
    throw new CfdiParseError(
      `The XML is ${xml.length} characters, over the ${MAX_XML_CHARS} limit this server parses. Pass a single CFDI, not a batch.`,
      "too_large",
    );
  }

  const problems: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({
      // Collect warnings instead of letting xmldom write to the console — on
      // stdio anything on stdout would corrupt the JSON-RPC stream.
      onError: (level, message) => {
        if (level !== "warning") problems.push(String(message).split("\n")[0] ?? String(message));
      },
    }).parseFromString(xml.trim(), "application/xml");
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new CfdiParseError(`The input is not well-formed XML: ${detail}`, "parse");
  }
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new CfdiParseError("The input is not well-formed XML (parser error node found).", "parse");
  }

  const root = doc.documentElement;
  if (!root || root.localName !== "Comprobante") {
    throw new CfdiParseError(
      `The input is valid XML but not a CFDI: the root element is '${root?.nodeName ?? "(none)"}', expected 'Comprobante' (usually written 'cfdi:Comprobante').`,
      "not_cfdi",
    );
  }

  const emisorEl = child(root, "Emisor");
  const receptorEl = child(root, "Receptor");
  const conceptosEl = child(root, "Conceptos");
  const impuestosEl = child(root, "Impuestos");
  const timbreEl = descendants(child(root, "Complemento"), "TimbreFiscalDigital")[0] ?? null;

  const conceptos: CfdiConcepto[] = elementChildren(conceptosEl)
    .filter((n) => n.localName === "Concepto")
    .map((n) => {
      const imp = child(n, "Impuestos");
      return {
        descripcion: attr(n, "Descripcion"),
        clave_prod_serv: attr(n, "ClaveProdServ"),
        cantidad: attr(n, "Cantidad"),
        clave_unidad: attr(n, "ClaveUnidad"),
        unidad: attr(n, "Unidad"),
        valor_unitario: attr(n, "ValorUnitario"),
        importe: attr(n, "Importe"),
        descuento: attr(n, "Descuento"),
        objeto_imp: attr(n, "ObjetoImp"),
        objeto_imp_label: label(attr(n, "ObjetoImp"), CFDI_OBJETO_IMP),
        traslados: readImpuestos(imp, "Traslados", "Traslado"),
        retenciones: readImpuestos(imp, "Retenciones", "Retencion"),
      };
    });

  const emisorRfc = attr(emisorEl, "Rfc");
  const receptorRfc = attr(receptorEl, "Rfc");
  const emisorReport = reportRfc(emisorRfc);
  const receptorReport = reportRfc(receptorRfc);

  const version = attr(root, "Version");
  const base = {
    sub_total: attr(root, "SubTotal"),
    descuento: attr(root, "Descuento"),
    total: attr(root, "Total"),
    total_trasladados: attr(impuestosEl, "TotalImpuestosTrasladados"),
    total_retenidos: attr(impuestosEl, "TotalImpuestosRetenidos"),
  };
  const arithmetic = checkArithmetic(base);

  const findings: Finding[] = [];
  if (version === "4.0") {
    findings.push({ severity: "pass", message: "CFDI version 4.0." });
  } else if (version) {
    findings.push({
      severity: "warn",
      message: `Declared version is '${version}', not 4.0. The fields are read the same way, but 3.3 and earlier are no longer issuable and some attributes this tool reports (Exportacion, DomicilioFiscalReceptor, RegimenFiscalReceptor, ObjetoImp) do not exist there.`,
    });
  } else {
    findings.push({ severity: "fail", message: "The Comprobante carries no Version attribute." });
  }

  findings.push(
    timbreEl
      ? { severity: "pass", message: "The document carries a Timbre Fiscal Digital (it was stamped by a PAC)." }
      : {
          severity: "warn",
          message:
            "No Timbre Fiscal Digital: this is an unstamped XML (a pre-invoice, or one whose complemento was stripped). It has no UUID and the SAT has no record of it.",
        },
  );

  for (const [who, report] of [
    ["Emisor", emisorReport],
    ["Receptor", receptorReport],
  ] as const) {
    if (!report.normalized) {
      findings.push({ severity: "fail", message: `${who} carries no Rfc attribute.` });
    } else if (report.valid && report.is_generic) {
      findings.push({
        severity: "info",
        message: `${who} RFC ${report.normalized} is a SAT generic (${report.generic_note}).`,
      });
    } else if (report.valid) {
      findings.push({ severity: "pass", message: `${who} RFC ${report.normalized} is structurally valid.` });
    } else {
      findings.push({
        severity: "fail",
        message: `${who} RFC ${report.normalized} does not validate: ${report.errors.map((e) => e.code).join(", ")}.`,
      });
    }
  }

  if (arithmetic.matches === false) {
    findings.push({
      severity: "warn",
      message: `The declared total (${arithmetic.declared_total}) differs from subtotal − discount + transferred − withheld (${arithmetic.computed_total}) by ${arithmetic.difference}.`,
    });
  } else if (arithmetic.matches === true) {
    findings.push({ severity: "pass", message: "Totals add up: subtotal − discount + transferred − withheld = total." });
  }

  findings.push({
    severity: "info",
    message:
      "This reads the XML only. It does not verify the digital signature and does not ask the SAT whether the invoice is still live — run cfdi_status for that.",
  });

  for (const problem of problems.slice(0, 3)) {
    findings.push({ severity: "warn", message: `XML parser note: ${problem}` });
  }

  return {
    version,
    serie: attr(root, "Serie"),
    folio: attr(root, "Folio"),
    fecha: attr(root, "Fecha"),
    tipo: attr(root, "TipoDeComprobante"),
    tipo_label: label(attr(root, "TipoDeComprobante"), CFDI_TIPO),
    forma_pago: attr(root, "FormaPago"),
    forma_pago_label: label(attr(root, "FormaPago"), CFDI_FORMA_PAGO),
    metodo_pago: attr(root, "MetodoPago"),
    metodo_pago_label: label(attr(root, "MetodoPago"), CFDI_METODO_PAGO),
    moneda: attr(root, "Moneda"),
    tipo_cambio: attr(root, "TipoCambio"),
    sub_total: base.sub_total,
    descuento: base.descuento,
    total: base.total,
    lugar_expedicion: attr(root, "LugarExpedicion"),
    exportacion: attr(root, "Exportacion"),
    condiciones_de_pago: attr(root, "CondicionesDePago"),
    no_certificado: attr(root, "NoCertificado"),
    emisor: {
      rfc: emisorRfc,
      nombre: attr(emisorEl, "Nombre"),
      regimen: attr(emisorEl, "RegimenFiscal"),
      regimen_label: label(attr(emisorEl, "RegimenFiscal"), CFDI_REGIMEN),
      rfc_valid: emisorReport.valid,
      rfc_kind: emisorReport.kind,
      rfc_errors: emisorReport.errors.map((e) => e.code),
    },
    receptor: {
      rfc: receptorRfc,
      nombre: attr(receptorEl, "Nombre"),
      domicilio: attr(receptorEl, "DomicilioFiscalReceptor"),
      regimen: attr(receptorEl, "RegimenFiscalReceptor"),
      regimen_label: label(attr(receptorEl, "RegimenFiscalReceptor"), CFDI_REGIMEN),
      uso: attr(receptorEl, "UsoCFDI"),
      uso_label: label(attr(receptorEl, "UsoCFDI"), CFDI_USO),
      rfc_valid: receptorReport.valid,
      rfc_kind: receptorReport.kind,
      rfc_errors: receptorReport.errors.map((e) => e.code),
    },
    conceptos,
    concepto_count: conceptos.length,
    total_trasladados: base.total_trasladados,
    total_retenidos: base.total_retenidos,
    stamped: timbreEl !== null,
    timbre: timbreEl
      ? {
          uuid: attr(timbreEl, "UUID"),
          fecha_timbrado: attr(timbreEl, "FechaTimbrado"),
          no_certificado_sat: attr(timbreEl, "NoCertificadoSAT"),
          rfc_prov_certif: attr(timbreEl, "RfcProvCertif"),
        }
      : null,
    arithmetic,
    findings,
  };
}
