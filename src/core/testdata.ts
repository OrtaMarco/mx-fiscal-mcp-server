/**
 * Structurally valid Mexican identifiers for fixtures, seeds and demo data.
 *
 * The generation itself is `mx-identifiers`' `generatePerson` / `generateCompany`:
 * the RFC's homoclave and the CURP's internal consonants are derived from the
 * name with the public rules, the characters the SAT assigns with its own
 * internal algorithm are drawn at random, and the check digit is recomputed
 * afterwards — so the output passes any format and check-digit validation
 * without matching any real record at the SAT, RENAPO, IMSS or Banxico.
 */

import { generateCompany, generatePerson } from "mx-identifiers";
import { MAX_GENERATED_RECORDS } from "../constants.js";
import type { Finding } from "../format.js";

export type TestDataKind = "person" | "company";

export interface GeneratedPersonRecord {
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string;
  sexo: string;
  fecha_nacimiento: string;
  entidad: string;
  entidad_nombre: string;
  rfc: string;
  curp: string;
  clabe: string;
  banco: string;
  nss: string;
  codigo_postal: string;
  telefono: string;
  email: string;
}

export interface GeneratedCompanyRecord {
  razon_social: string;
  rfc: string;
  clabe: string;
  banco: string;
  codigo_postal: string;
  fecha_constitucion: string;
}

export interface TestDataResult {
  kind: TestDataKind;
  count: number;
  people: GeneratedPersonRecord[];
  companies: GeneratedCompanyRecord[];
  findings: Finding[];
}

export function generateTestData(kind: TestDataKind, count: number): TestDataResult {
  const n = Math.max(1, Math.min(MAX_GENERATED_RECORDS, Math.trunc(count)));

  const people: GeneratedPersonRecord[] = [];
  const companies: GeneratedCompanyRecord[] = [];

  if (kind === "person") {
    for (let i = 0; i < n; i++) {
      const p = generatePerson();
      people.push({
        nombre: p.nombre,
        apellido_paterno: p.apellidoPaterno,
        apellido_materno: p.apellidoMaterno,
        sexo: p.sexo,
        fecha_nacimiento: p.fechaNacimiento,
        entidad: p.entidad,
        entidad_nombre: p.entidadNombre,
        rfc: p.rfc,
        curp: p.curp,
        clabe: p.clabe,
        banco: p.banco,
        nss: p.nss,
        codigo_postal: p.codigoPostal,
        telefono: p.telefono,
        email: p.email,
      });
    }
  } else {
    for (let i = 0; i < n; i++) {
      const c = generateCompany();
      companies.push({
        razon_social: c.razonSocial,
        rfc: c.rfc,
        clabe: c.clabe,
        banco: c.banco,
        codigo_postal: c.codigoPostal,
        fecha_constitucion: c.fechaConstitucion,
      });
    }
  }

  return {
    kind,
    count: n,
    people,
    companies,
    findings: [
      {
        severity: "info",
        message:
          "Every identifier here satisfies its check digit but corresponds to no real person or company. Use it for fixtures, seeds and demos — never as a stand-in for a customer's real data.",
      },
      {
        severity: "info",
        message:
          "Within one record the values are coherent: the RFC and the CURP are derived from the same name, sex, birth date and state, and the CLABE's bank code is a real Banxico participant.",
      },
      {
        severity: "warn",
        message:
          "Do not feed these to the SAT's status service or to a PAC: an RFC that is well-formed is not an RFC that is registered.",
      },
    ],
  };
}
