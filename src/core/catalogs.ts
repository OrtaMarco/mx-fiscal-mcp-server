/**
 * Lookup over the SAT / Banxico / RENAPO catalogues bundled in
 * `mx-identifiers`. Nothing is fetched: these ship with the package, so the
 * tool works with no network at all.
 */

import {
  CFDI_FORMA_PAGO,
  CFDI_IMPUESTOS,
  CFDI_METODO_PAGO,
  CFDI_OBJETO_IMP,
  CFDI_REGIMEN,
  CFDI_TIPO,
  CFDI_USO,
  CLABE_BANKS,
  CURP_STATES,
} from "mx-identifiers";

export const CATALOG_NAMES = [
  "regimen_fiscal",
  "uso_cfdi",
  "forma_pago",
  "metodo_pago",
  "tipo_comprobante",
  "objeto_imp",
  "impuestos",
  "bancos_clabe",
  "estados_curp",
] as const;

export type CatalogName = (typeof CATALOG_NAMES)[number];

interface CatalogMeta {
  data: Record<string, string>;
  official_name: string;
  authority: string;
  description: string;
  /** Where this catalogue's codes appear in a document. */
  used_in: string;
}

const CATALOGS: Record<CatalogName, CatalogMeta> = {
  regimen_fiscal: {
    data: CFDI_REGIMEN,
    official_name: "c_RegimenFiscal",
    authority: "SAT",
    description: "Tax regime of the issuer and of the receiver of a CFDI.",
    used_in: "cfdi:Emisor@RegimenFiscal and cfdi:Receptor@RegimenFiscalReceptor",
  },
  uso_cfdi: {
    data: CFDI_USO,
    official_name: "c_UsoCFDI",
    authority: "SAT",
    description: "What the receiver will do with the invoice for tax purposes.",
    used_in: "cfdi:Receptor@UsoCFDI",
  },
  forma_pago: {
    data: CFDI_FORMA_PAGO,
    official_name: "c_FormaPago",
    authority: "SAT",
    description: "How the invoice was paid: cash, transfer, card, and so on.",
    used_in: "cfdi:Comprobante@FormaPago",
  },
  metodo_pago: {
    data: CFDI_METODO_PAGO,
    official_name: "c_MetodoPago",
    authority: "SAT",
    description:
      "Whether the invoice is paid in one go (PUE) or in instalments / deferred (PPD, which requires a later complemento de pago).",
    used_in: "cfdi:Comprobante@MetodoPago",
  },
  tipo_comprobante: {
    data: CFDI_TIPO,
    official_name: "c_TipoDeComprobante",
    authority: "SAT",
    description: "Kind of document: income, expense, transfer, payroll or payment.",
    used_in: "cfdi:Comprobante@TipoDeComprobante",
  },
  objeto_imp: {
    data: CFDI_OBJETO_IMP,
    official_name: "c_ObjetoImp",
    authority: "SAT",
    description: "Whether a line item is subject to tax, and how it must be broken down. Introduced by CFDI 4.0.",
    used_in: "cfdi:Concepto@ObjetoImp",
  },
  impuestos: {
    data: CFDI_IMPUESTOS,
    official_name: "c_Impuesto",
    authority: "SAT",
    description: "The three taxes a CFDI can transfer or withhold: ISR, IVA and IEPS.",
    used_in: "cfdi:Traslado@Impuesto and cfdi:Retencion@Impuesto",
  },
  bancos_clabe: {
    data: CLABE_BANKS,
    official_name: "Catálogo de participantes (SPEI)",
    authority: "Banxico",
    description:
      "Institutions indexed by the first three digits of a CLABE. This is a curated subset, not the complete participant list — an unknown code is reported as unknown rather than given an invented name.",
    used_in: "digits 1-3 of an 18-digit CLABE",
  },
  estados_curp: {
    data: CURP_STATES,
    official_name: "Entidades de nacimiento (CURP)",
    authority: "RENAPO",
    description:
      "The 32 federal entities plus NE (born abroad), as they appear in positions 12-13 of a CURP. These two-letter keys are RENAPO's own and do NOT match the INEGI or ISO 3166-2:MX codes.",
    used_in: "positions 12-13 of an 18-character CURP",
  },
};

export interface CatalogEntry {
  code: string;
  label: string;
}

export interface CatalogLookup {
  catalog: CatalogName;
  official_name: string;
  authority: string;
  description: string;
  used_in: string;
  query: string | null;
  match_type: "all" | "exact" | "search";
  total_entries: number;
  match_count: number;
  entries: CatalogEntry[];
  truncated: boolean;
  notes: string[];
}

/** Case- and accent-insensitive comparison key. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Codes are compared without leading zeros so '1' finds '01'. */
function codeKey(value: string): string {
  return value.trim().toUpperCase().replace(/^0+(?=.)/, "");
}

const MAX_ENTRIES = 400;

export function lookupCatalog(catalog: CatalogName, query?: string): CatalogLookup {
  const meta = CATALOGS[catalog];
  const all: CatalogEntry[] = Object.entries(meta.data).map(([code, label]) => ({ code, label }));
  const trimmed = query?.trim() ?? "";
  const notes: string[] = [];

  let entries = all;
  let matchType: CatalogLookup["match_type"] = "all";

  if (trimmed) {
    const exact = all.filter((e) => codeKey(e.code) === codeKey(trimmed));
    if (exact.length > 0) {
      entries = exact;
      matchType = "exact";
    } else {
      const needle = fold(trimmed);
      entries = all.filter((e) => fold(e.code).includes(needle) || fold(e.label).includes(needle));
      matchType = "search";
      if (entries.length === 0) {
        notes.push(
          `No entry in ${meta.official_name} matches '${trimmed}'. Call the tool again without a query to see the whole catalogue.`,
        );
      }
    }
  }

  if (catalog === "bancos_clabe") {
    notes.push(
      "This is a curated subset of Banxico's participant catalogue. A code that is absent here can still belong to a real institution.",
    );
  }
  if (catalog === "regimen_fiscal") {
    notes.push(
      "The SAT's published catalogue also carries per-regime flags for whether a regime is valid for a persona física, a persona moral, or both. Those flags are not bundled here.",
    );
  }

  const truncated = entries.length > MAX_ENTRIES;
  return {
    catalog,
    official_name: meta.official_name,
    authority: meta.authority,
    description: meta.description,
    used_in: meta.used_in,
    query: trimmed || null,
    match_type: matchType,
    total_entries: all.length,
    match_count: entries.length,
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated,
    notes,
  };
}
