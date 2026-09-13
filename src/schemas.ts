/**
 * Zod output schemas for every tool.
 *
 * These are the `outputSchema` the SDK advertises AND validates
 * `structuredContent` against, so they are kept exactly in step with the
 * interfaces in `core/*`: a drift fails on the first call rather than silently
 * in somebody's client.
 *
 * Authored with Zod 4 via the `zod/v4` subpath — the v2 SDK requires ≥4.2 and
 * fails quietly on the first `tools/list` with Zod 3.
 */

import * as z from "zod/v4";
import { CATALOG_NAMES } from "./core/catalogs.js";

const Finding = z.object({
  severity: z.enum(["pass", "warn", "fail", "info"]),
  message: z.string(),
});
const Findings = z.array(Finding);

const IdentifierError = z.object({ code: z.string(), message: z.string() });
const IdentifierErrors = z.array(IdentifierError);

// --- identifiers ------------------------------------------------------------

export const RfcSchema = z.object({
  input: z.string(),
  normalized: z.string(),
  valid: z.boolean(),
  kind: z.string().nullable(),
  is_generic: z.boolean(),
  generic_note: z.string().nullable(),
  parts: z
    .object({
      iniciales: z.string(),
      fecha: z.string(),
      homoclave: z.string(),
      digito: z.string(),
    })
    .nullable(),
  birth_date: z.string().nullable(),
  expected_check_digit: z.string().nullable(),
  check_digit_satisfied: z.boolean().nullable(),
  errors: IdentifierErrors,
  findings: Findings,
});

export const CurpSchema = z.object({
  input: z.string(),
  normalized: z.string(),
  valid: z.boolean(),
  parts: z
    .object({
      iniciales: z.string(),
      fecha: z.string(),
      sexo: z.string(),
      entidad: z.string(),
      consonantes: z.string(),
      homoclave: z.string(),
      digito: z.string(),
    })
    .nullable(),
  birth_date: z.string().nullable(),
  sex: z.string().nullable(),
  sex_label: z.string().nullable(),
  state_key: z.string().nullable(),
  state_name: z.string().nullable(),
  century_marker: z.string().nullable(),
  expected_check_digit: z.string().nullable(),
  errors: IdentifierErrors,
  findings: Findings,
});

export const ClabeSchema = z.object({
  input: z.string(),
  normalized: z.string(),
  formatted: z.string().nullable(),
  valid: z.boolean(),
  parts: z
    .object({
      banco: z.string(),
      plaza: z.string(),
      cuenta: z.string(),
      digito: z.string(),
    })
    .nullable(),
  bank_code: z.string().nullable(),
  bank_name: z.string().nullable(),
  plaza_code: z.string().nullable(),
  plaza_note: z.string().nullable(),
  expected_check_digit: z.string().nullable(),
  errors: IdentifierErrors,
  findings: Findings,
});

export const NssSchema = z.object({
  input: z.string(),
  normalized: z.string(),
  valid: z.boolean(),
  parts: z
    .object({
      subdelegacion: z.string(),
      anioAlta: z.string(),
      anioNacimiento: z.string(),
      folio: z.string(),
      digito: z.string(),
    })
    .nullable(),
  expected_check_digit: z.string().nullable(),
  errors: IdentifierErrors,
  findings: Findings,
});

// --- test data --------------------------------------------------------------

export const TestDataSchema = z.object({
  kind: z.enum(["person", "company"]),
  count: z.number(),
  people: z.array(
    z.object({
      nombre: z.string(),
      apellido_paterno: z.string(),
      apellido_materno: z.string(),
      sexo: z.string(),
      fecha_nacimiento: z.string(),
      entidad: z.string(),
      entidad_nombre: z.string(),
      rfc: z.string(),
      curp: z.string(),
      clabe: z.string(),
      banco: z.string(),
      nss: z.string(),
      codigo_postal: z.string(),
      telefono: z.string(),
      email: z.string(),
    }),
  ),
  companies: z.array(
    z.object({
      razon_social: z.string(),
      rfc: z.string(),
      clabe: z.string(),
      banco: z.string(),
      codigo_postal: z.string(),
      fecha_constitucion: z.string(),
    }),
  ),
  findings: Findings,
});

// --- CFDI -------------------------------------------------------------------

const Impuesto = z.object({
  base: z.string(),
  impuesto: z.string(),
  impuesto_label: z.string().nullable(),
  tipo_factor: z.string(),
  tasa_o_cuota: z.string(),
  importe: z.string(),
});

const Party = {
  rfc: z.string(),
  nombre: z.string(),
  regimen: z.string(),
  regimen_label: z.string().nullable(),
  rfc_valid: z.boolean(),
  rfc_kind: z.string().nullable(),
  rfc_errors: z.array(z.string()),
};

export const CfdiSchema = z.object({
  version: z.string(),
  serie: z.string(),
  folio: z.string(),
  fecha: z.string(),
  tipo: z.string(),
  tipo_label: z.string().nullable(),
  forma_pago: z.string(),
  forma_pago_label: z.string().nullable(),
  metodo_pago: z.string(),
  metodo_pago_label: z.string().nullable(),
  moneda: z.string(),
  tipo_cambio: z.string(),
  sub_total: z.string(),
  descuento: z.string(),
  total: z.string(),
  lugar_expedicion: z.string(),
  exportacion: z.string(),
  condiciones_de_pago: z.string(),
  no_certificado: z.string(),
  emisor: z.object(Party),
  receptor: z.object({
    ...Party,
    domicilio: z.string(),
    uso: z.string(),
    uso_label: z.string().nullable(),
  }),
  conceptos: z.array(
    z.object({
      descripcion: z.string(),
      clave_prod_serv: z.string(),
      cantidad: z.string(),
      clave_unidad: z.string(),
      unidad: z.string(),
      valor_unitario: z.string(),
      importe: z.string(),
      descuento: z.string(),
      objeto_imp: z.string(),
      objeto_imp_label: z.string().nullable(),
      traslados: z.array(Impuesto),
      retenciones: z.array(Impuesto),
    }),
  ),
  concepto_count: z.number(),
  conceptos_truncated: z.boolean(),
  total_trasladados: z.string(),
  total_retenidos: z.string(),
  total_traslados_locales: z.string(),
  total_retenciones_locales: z.string(),
  stamped: z.boolean(),
  timbre: z
    .object({
      uuid: z.string(),
      fecha_timbrado: z.string(),
      no_certificado_sat: z.string(),
      rfc_prov_certif: z.string(),
    })
    .nullable(),
  arithmetic: z.object({
    declared_total: z.string(),
    computed_total: z.string().nullable(),
    matches: z.boolean().nullable(),
    difference: z.string().nullable(),
  }),
  findings: Findings,
});

export const CfdiStatusSchema = z.object({
  available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  endpoint: z.string(),
  expression: z.string(),
  attempts: z.number(),
  elapsed_ms: z.number(),
  source: z.enum(["fields", "xml"]),
  status: z
    .object({
      codigo_estatus: z.string(),
      query_outcome: z.enum(["found", "not_found"]),
      estado: z.string(),
      document_state: z.enum(["vigente", "cancelado", "no_encontrado"]),
      document_meaning: z.string(),
      es_cancelable: z.string(),
      cancellable_state: z.enum(["sin_aceptacion", "con_aceptacion", "no_cancelable", "unknown"]),
      cancellable_meaning: z.string(),
      estatus_cancelacion: z.string(),
      cancellation_state: z.enum([
        "cancelado_sin_aceptacion",
        "cancelado_con_aceptacion",
        "plazo_vencido",
        "en_proceso",
        "solicitud_rechazada",
        "ninguno",
      ]),
      cancellation_meaning: z.string(),
      validacion_efos: z.string(),
      efos_state: z.enum(["not_listed", "listed", "unknown"]),
      efos_third_party_state: z.enum(["listed", "not_listed", "not_reported", "unknown"]),
      efos_meaning: z.string(),
      raw: z.record(z.string(), z.string()),
    })
    .nullable(),
  findings: Findings,
});

// --- catalogues -------------------------------------------------------------

export const CatalogSchema = z.object({
  catalog: z.enum(CATALOG_NAMES),
  official_name: z.string(),
  authority: z.string(),
  description: z.string(),
  used_in: z.string(),
  query: z.string().nullable(),
  match_type: z.enum(["all", "exact", "search"]),
  total_entries: z.number(),
  match_count: z.number(),
  entries: z.array(z.object({ code: z.string(), label: z.string() })),
  truncated: z.boolean(),
  notes: z.array(z.string()),
});
