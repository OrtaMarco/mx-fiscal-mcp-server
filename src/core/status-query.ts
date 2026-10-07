/**
 * Turn what a caller passed (the whole XML, or the four key fields) into the
 * query the SAT keys on. Shared by `cfdi_status` and `cfdi_batch_status` so both
 * refuse the same inputs for the same reasons.
 */

import { CfdiParseError, parseCfdi } from "./cfdi.js";
import { validateStatusQuery } from "./sat.js";

export interface StatusQuery {
  rfc_emisor: string;
  rfc_receptor: string;
  total: string;
  uuid: string;
}

export interface StatusInput {
  xml?: string;
  rfc_emisor?: string;
  rfc_receptor?: string;
  total?: string;
  uuid?: string;
}

export type ResolvedStatusQuery =
  | { ok: true; query: StatusQuery; source: "fields" | "xml" }
  | { ok: false; message: string };

export function resolveStatusQuery(input: StatusInput): ResolvedStatusQuery {
  const { xml, rfc_emisor, rfc_receptor, total, uuid } = input;

  if (xml && xml.trim()) {
    let doc;
    try {
      doc = parseCfdi(xml);
    } catch (err) {
      if (err instanceof CfdiParseError) return { ok: false, message: `Error: ${err.message}` };
      return { ok: false, message: `Error reading the CFDI: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!doc.timbre?.uuid) {
      return {
        ok: false,
        message:
          "Error: this CFDI carries no Timbre Fiscal Digital, so it has no UUID and the SAT has no record of it. An unstamped XML cannot be looked up.",
      };
    }
    return {
      ok: true,
      source: "xml",
      query: {
        rfc_emisor: doc.emisor.rfc,
        rfc_receptor: doc.receptor.rfc,
        total: doc.total,
        uuid: doc.timbre.uuid,
      },
    };
  }

  const missing = [
    ["rfc_emisor", rfc_emisor],
    ["rfc_receptor", rfc_receptor],
    ["total", total],
    ["uuid", uuid],
  ]
    .filter(([, v]) => !v || !String(v).trim())
    .map(([k]) => k);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Error: missing ${missing.join(", ")}. Pass either the whole invoice as \`xml\`, or all four of rfc_emisor, rfc_receptor, total and uuid.`,
    };
  }
  const query: StatusQuery = {
    rfc_emisor: rfc_emisor as string,
    rfc_receptor: rfc_receptor as string,
    total: total as string,
    uuid: uuid as string,
  };
  const problems = validateStatusQuery(query);
  if (problems.length > 0) {
    return {
      ok: false,
      message: `Error: not sent to the SAT, because the query would come back 'No Encontrado' for the wrong reason:\n- ${problems.join("\n- ")}`,
    };
  }
  return { ok: true, query, source: "fields" };
}
