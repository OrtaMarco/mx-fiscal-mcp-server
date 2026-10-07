/**
 * Deterministic unit tests for the logic a live smoke test cannot pin down:
 * the CFDI reader (against two committed fixtures), the SOAP envelope and
 * expression builders, the catalogue lookup, the identifier reports and the
 * generator.
 *
 *   npm test
 *
 * Everything here runs offline. The SAT is never contacted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseCfdi, CfdiParseError } from "../dist/core/cfdi.js";
import {
  buildExpression,
  buildSoapEnvelope,
  expressionRfc,
  validateStatusQuery,
  extractConsultaResult,
  formatExpressionTotal,
  interpret,
  queryCfdiStatus,
} from "../dist/core/sat.js";
import { BATCH_CONCURRENCY, BATCH_OUTAGE_STOP, batchCfdiStatus, clearStatusCache } from "../dist/core/status-batch.js";
import { lookupCatalog, CATALOG_NAMES } from "../dist/core/catalogs.js";
import { reportClabe, reportCurp, reportNss, reportRfc } from "../dist/core/identifiers.js";
import { generateTestData } from "../dist/core/testdata.js";
import { MAX_ATTR_CHARS, MAX_REPORTED_CONCEPTOS, MAX_XML_ELEMENTS } from "../dist/constants.js";
import { clabeCheckDigit, validateClabe, validateCurp, validateNss, validateRfc } from "mx-identifiers";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const stamped = readFileSync(join(FIXTURES, "cfdi40-timbrado.xml"), "utf8");
const unstamped = readFileSync(join(FIXTURES, "cfdi40-sin-timbre.xml"), "utf8");

// --- CFDI reader -----------------------------------------------------------

test("reads the header of a stamped CFDI 4.0", () => {
  const doc = parseCfdi(stamped);
  assert.equal(doc.version, "4.0");
  assert.equal(doc.serie, "A");
  assert.equal(doc.folio, "1042");
  assert.equal(doc.tipo, "I");
  assert.equal(doc.tipo_label, "Ingreso");
  assert.equal(doc.metodo_pago, "PUE");
  assert.equal(doc.metodo_pago_label, "Pago en una sola exhibición");
  assert.equal(doc.forma_pago_label, "Transferencia electrónica de fondos");
  assert.equal(doc.total, "1160.00");
  assert.equal(doc.lugar_expedicion, "64000");
});

test("labels the issuer and receiver catalogue codes", () => {
  const doc = parseCfdi(stamped);
  assert.equal(doc.emisor.rfc, "TES150312DX2");
  assert.equal(doc.emisor.regimen_label, "General de Ley Personas Morales");
  assert.equal(doc.receptor.rfc, "PELJ900521DK2");
  assert.equal(doc.receptor.regimen_label, "Personas Físicas con Actividades Empresariales y Profesionales");
  assert.equal(doc.receptor.uso_label, "Gastos en general");
  assert.equal(doc.receptor.domicilio, "03100");
});

test("validates both RFCs while reading", () => {
  const doc = parseCfdi(stamped);
  assert.equal(doc.emisor.rfc_valid, true);
  assert.equal(doc.emisor.rfc_kind, "moral");
  assert.equal(doc.receptor.rfc_valid, true);
  assert.equal(doc.receptor.rfc_kind, "fisica");
  assert.deepEqual(doc.emisor.rfc_errors, []);
});

test("reads every concepto with its transferred taxes", () => {
  const doc = parseCfdi(stamped);
  assert.equal(doc.concepto_count, 2);
  const [first, second] = doc.conceptos;
  assert.equal(first.descripcion, "Desarrollo de sitio web");
  assert.equal(first.importe, "800.00");
  assert.equal(first.objeto_imp_label, "Sí objeto de impuesto");
  assert.equal(first.traslados.length, 1);
  assert.equal(first.traslados[0].impuesto_label, "IVA");
  assert.equal(first.traslados[0].importe, "128.00");
  assert.equal(first.retenciones.length, 0);
  assert.equal(second.cantidad, "2");
  assert.equal(second.importe, "200.00");
});

test("reads the Timbre Fiscal Digital regardless of its prefix", () => {
  const doc = parseCfdi(stamped);
  assert.equal(doc.stamped, true);
  assert.equal(doc.timbre.uuid, "5A7B3C1D-9E2F-4A6B-8C0D-1E2F3A4B5C6D");
  assert.equal(doc.timbre.fecha_timbrado, "2026-03-11T09:14:58");
  assert.equal(doc.timbre.no_certificado_sat, "30001000000500003417");
  assert.equal(doc.timbre.rfc_prov_certif, "TES150312DX2");
});

test("totals that add up are reported as matching", () => {
  const doc = parseCfdi(stamped);
  assert.equal(doc.arithmetic.matches, true);
  assert.equal(doc.arithmetic.computed_total, "1160.00");
});

test("an unstamped CFDI with no cfdi: prefix still parses", () => {
  const doc = parseCfdi(unstamped);
  assert.equal(doc.version, "4.0");
  assert.equal(doc.serie, "B");
  assert.equal(doc.stamped, false);
  assert.equal(doc.timbre, null);
  assert.equal(doc.concepto_count, 1);
  assert.equal(doc.conceptos[0].descripcion, "Tortilla de maiz");
});

test("the generic receiver RFC is flagged as generic, not as a persona física", () => {
  const doc = parseCfdi(unstamped);
  assert.equal(doc.receptor.rfc, "XAXX010101000");
  assert.equal(doc.receptor.rfc_valid, true);
  assert.equal(doc.receptor.rfc_kind, "generico");
});

test("a total that does not add up produces a warning, not a failure", () => {
  const doc = parseCfdi(unstamped);
  assert.equal(doc.arithmetic.matches, false);
  assert.equal(doc.arithmetic.computed_total, "580.00");
  assert.equal(doc.arithmetic.difference, "10.00");
  assert.ok(doc.findings.some((f) => f.severity === "warn" && /differs from subtotal/.test(f.message)));
});

test("malformed XML raises a CfdiParseError, not a crash", () => {
  assert.throws(() => parseCfdi("<cfdi:Comprobante><oops></cfdi:Comprobante>"), CfdiParseError);
});

test("valid XML that is not a CFDI is reported as such", () => {
  try {
    parseCfdi("<factura><total>10</total></factura>");
    assert.fail("expected a CfdiParseError");
  } catch (err) {
    assert.ok(err instanceof CfdiParseError);
    assert.equal(err.reason, "not_cfdi");
  }
});

// --- SAT expression & envelope --------------------------------------------

test("the total is formatted with six decimals, trailing zeros trimmed", () => {
  assert.equal(formatExpressionTotal("1160.00"), "1160.0");
  assert.equal(formatExpressionTotal("1234.56"), "1234.56");
  assert.equal(formatExpressionTotal("0.01"), "0.01");
  assert.equal(formatExpressionTotal("100"), "100.0");
  assert.equal(formatExpressionTotal("12.345678"), "12.345678");
});

test("the expression carries re, rr, tt and id in that order", () => {
  const expression = buildExpression({
    rfc_emisor: "tes150312dx2",
    rfc_receptor: "PELJ900521DK2",
    total: "1160.00",
    uuid: "5a7b3c1d-9e2f-4a6b-8c0d-1e2f3a4b5c6d",
  });
  assert.equal(
    expression,
    "?re=TES150312DX2&rr=PELJ900521DK2&tt=1160.0&id=5A7B3C1D-9E2F-4A6B-8C0D-1E2F3A4B5C6D",
  );
});

test("the SOAP envelope matches the shape nodecfdi/sat-estado-cfdi sends", () => {
  const envelope = buildSoapEnvelope("?re=A&rr=B&tt=1.0&id=C");
  assert.ok(envelope.startsWith('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'));
  assert.ok(envelope.includes("<s:Body>"));
  assert.ok(envelope.includes('<c:Consulta xmlns:c="http://tempuri.org/">'));
  assert.ok(envelope.includes("<c:expresionImpresa>"));
  // The ampersands inside the expression must be escaped or the envelope is
  // not well-formed XML and the SAT answers a fault.
  assert.ok(envelope.includes("?re=A&amp;rr=B&amp;tt=1.0&amp;id=C"));
  assert.ok(envelope.endsWith("</s:Envelope>"));
});

test("the ConsultaResult children are lifted out of a SOAP response", () => {
  const body = `<?xml version="1.0"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
      <s:Body>
        <ConsultaResponse xmlns="http://tempuri.org/">
          <ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi.Negocio.ConsultaCfdi.Servicio">
            <a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus>
            <a:EsCancelable>Cancelable con aceptación</a:EsCancelable>
            <a:Estado>Vigente</a:Estado>
            <a:EstatusCancelacion/>
            <a:ValidacionEFOS>200</a:ValidacionEFOS>
          </ConsultaResult>
        </ConsultaResponse>
      </s:Body>
    </s:Envelope>`;
  const values = extractConsultaResult(body);
  assert.equal(values.Estado, "Vigente");
  assert.equal(values.CodigoEstatus, "S - Comprobante obtenido satisfactoriamente.");
  assert.equal(values.EsCancelable, "Cancelable con aceptación");
  assert.equal(values.ValidacionEFOS, "200");
});

test("a body with no ConsultaResult yields an empty record instead of throwing", () => {
  assert.deepEqual(extractConsultaResult("<html>service unavailable</html>"), {});
  assert.deepEqual(extractConsultaResult(""), {});
});

test("a live invoice is interpreted as vigente and not EFOS-listed", () => {
  const reading = interpret({
    CodigoEstatus: "S - Comprobante obtenido satisfactoriamente.",
    Estado: "Vigente",
    EsCancelable: "Cancelable con aceptación",
    EstatusCancelacion: "",
    ValidacionEFOS: "200",
  });
  assert.equal(reading.query_outcome, "found");
  assert.equal(reading.document_state, "vigente");
  assert.equal(reading.cancellable_state, "con_aceptacion");
  assert.equal(reading.cancellation_state, "ninguno");
  assert.equal(reading.efos_state, "not_listed");
});

test("a missing invoice is interpreted as no_encontrado", () => {
  const reading = interpret({
    CodigoEstatus: "N - 602: Comprobante no encontrado.",
    Estado: "No Encontrado",
    EsCancelable: "",
    EstatusCancelacion: "",
    ValidacionEFOS: "",
  });
  assert.equal(reading.query_outcome, "not_found");
  assert.equal(reading.document_state, "no_encontrado");
  assert.equal(reading.cancellable_state, "unknown");
  assert.equal(reading.efos_state, "unknown");
});

// The table in «Documentación del Servicio de Consulta de CFDI» v1.4, section 3.
const EFOS_TABLE = [
  // code, issuer, third parties, what the meaning must say
  ["100", "listed", "not_reported", /the issuer IS on/],
  ["101", "listed", "listed", /the issuer IS on .*and so is a third-party RFC/],
  ["102", "not_listed", "listed", /the issuer is NOT on .*but the third-party RFC .* IS/],
  ["103", "not_listed", "listed", /the issuer is NOT on .*but one of the several third-party RFCs .* IS/],
  ["104", "listed", "listed", /the issuer IS on .*and so is one of the several third-party RFCs/],
  ["200", "not_listed", "not_reported", /the issuer is NOT on/],
  ["201", "not_listed", "not_listed", /neither the issuer nor any of the third-party RFCs/],
];

for (const [code, issuer, thirdParty, meaning] of EFOS_TABLE) {
  test(`EFOS code ${code} → issuer ${issuer}, third parties ${thirdParty}`, () => {
    const reading = interpret({ ValidacionEFOS: code });
    assert.equal(reading.validacion_efos, code);
    assert.equal(reading.efos_state, issuer);
    assert.equal(reading.efos_third_party_state, thirdParty);
    assert.match(reading.efos_meaning, meaning);
    assert.match(reading.efos_meaning, /Documentación del Servicio de Consulta de CFDI» v1\.4/);
  });
}

test("102 and 103 never put the issuer on the 69-B list", () => {
  // 1.0.1 read every code other than 200/201 as "the issuer is listed", which
  // accused issuers the SAT explicitly says are NOT on the list.
  for (const code of ["102", "103"]) {
    const reading = interpret({ ValidacionEFOS: code });
    assert.notEqual(reading.efos_state, "listed");
    assert.doesNotMatch(reading.efos_meaning, /the issuer IS on/);
  }
});

test("an empty EFOS field is 'unknown', never 'listed'", () => {
  // The SAT returns it blank on a 'No Encontrado'. Reading that as "the issuer
  // is on the 69-B list" would be a serious accusation drawn from silence.
  const reading = interpret({ Estado: "No Encontrado", ValidacionEFOS: "" });
  assert.equal(reading.efos_state, "unknown");
  assert.equal(reading.efos_third_party_state, "unknown");
  assert.ok(/no EFOS field/.test(reading.efos_meaning));
  assert.equal(interpret({}).efos_state, "unknown");
});

test("an undocumented EFOS code is 'unknown' and keeps the raw code", () => {
  for (const code of ["105", "300", "abc", "toString"]) {
    const reading = interpret({ ValidacionEFOS: code });
    assert.equal(reading.validacion_efos, code);
    assert.equal(reading.efos_state, "unknown");
    assert.equal(reading.efos_third_party_state, "unknown");
    assert.ok(reading.efos_meaning.includes(`'${code}'`));
    assert.match(reading.efos_meaning, /not one of the codes the SAT documents/);
  }
});

test("cfdi_status findings warn on a listed issuer or third party, and only then", async () => {
  const realFetch = globalThis.fetch;
  const answer = (efos) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi.Negocio.ConsultaCfdi.Servicio">` +
    `<a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus><a:Estado>Vigente</a:Estado>` +
    `<a:ValidacionEFOS>${efos}</a:ValidacionEFOS></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>`;
  const query = {
    rfc_emisor: "TES150312DX2",
    rfc_receptor: "PELJ900521DK2",
    total: "1160.00",
    uuid: "5A7B3C1D-9E2F-4A6B-8C0D-1E2F3A4B5C6D",
  };
  try {
    const expectations = { 100: true, 101: true, 102: true, 103: true, 104: true, 200: false, 201: false };
    for (const [code, warns] of Object.entries(expectations)) {
      globalThis.fetch = async () => new Response(answer(code), { status: 200 });
      const result = await queryCfdiStatus(query);
      assert.equal(result.available, true);
      const efosWarning = result.findings.some((f) => f.severity === "warn" && /^EFOS check returned/.test(f.message));
      assert.equal(efosWarning, warns, `code ${code}`);
    }
    globalThis.fetch = async () => new Response(answer("999"), { status: 200 });
    const odd = await queryCfdiStatus(query);
    assert.ok(odd.findings.some((f) => f.severity === "info" && /'999'/.test(f.message)));
    assert.ok(!odd.findings.some((f) => f.severity === "warn" && /EFOS/.test(f.message)));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the SAT is not asked twice after a 4xx, but is after a 5xx or a network error", async () => {
  const realFetch = globalThis.fetch;
  const query = {
    rfc_emisor: "EKU9003173C9",
    rfc_receptor: "XAXX010101000",
    total: "1160.00",
    uuid: "00000000-0000-4000-8000-000000000001",
  };
  const ok =
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult>` +
    `<a:Estado xmlns:a="x">Vigente</a:Estado></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>`;
  let calls = 0;
  try {
    globalThis.fetch = async () => (calls++, new Response("bad request", { status: 400 }));
    const client = await queryCfdiStatus(query);
    assert.equal(client.available, false);
    assert.equal(calls, 1);
    assert.equal(client.attempts, 1);
    assert.match(client.unavailable_reason, /HTTP 400/);

    calls = 0;
    globalThis.fetch = async () => (calls++, new Response("down", { status: 503 }));
    const server = await queryCfdiStatus(query);
    assert.equal(server.available, false);
    assert.equal(calls, 2);
    assert.equal(server.attempts, 2);

    calls = 0;
    globalThis.fetch = async () => (++calls === 1 ? Promise.reject(new TypeError("fetch failed")) : new Response(ok, { status: 200 }));
    const recovered = await queryCfdiStatus(query);
    assert.equal(recovered.available, true);
    assert.equal(recovered.attempts, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const batchAnswer =
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult>` +
  `<a:CodigoEstatus xmlns:a="x">S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus><a:Estado xmlns:a="x">Vigente</a:Estado>` +
  `<a:ValidacionEFOS xmlns:a="x">200</a:ValidacionEFOS></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>`;
const uuidN = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fieldsFor = (n) => ({ rfc_emisor: "EKU9003173C9", rfc_receptor: "XAXX010101000", total: "10.00", uuid: uuidN(n) });

test("a batch asks the SAT at most two at a time, once per distinct invoice", async () => {
  const realFetch = globalThis.fetch;
  clearStatusCache();
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return new Response(batchAnswer, { status: 200 });
  };
  try {
    const items = [1, 2, 3, 4, 5, 3].map(fieldsFor); // the sixth repeats the third
    items.push({ rfc_emisor: "ABC", rfc_receptor: "XAXX010101000", total: "1", uuid: "nope" });
    const batch = await batchCfdiStatus(items);
    assert.equal(calls, 5);
    assert.ok(peak <= BATCH_CONCURRENCY, `peak ${peak}`);
    assert.equal(batch.queried, 5);
    assert.equal(batch.duplicates, 1);
    assert.equal(batch.rejected, 1);
    assert.equal(batch.items[5].outcome, "duplicate");
    assert.equal(batch.items[5].result.status.estado, "Vigente");
    assert.equal(batch.items[6].outcome, "rejected");
    assert.match(batch.items[6].error, /rfc_emisor/);

    // The same invoices again are answered from memory, with no request.
    const again = await batchCfdiStatus([1, 2].map(fieldsFor));
    assert.equal(calls, 5);
    assert.equal(again.cached, 2);
    assert.equal(again.queried, 0);
  } finally {
    globalThis.fetch = realFetch;
    clearStatusCache();
  }
});

test("a batch stops asking after two consecutive outages, and never caches an outage", async () => {
  const realFetch = globalThis.fetch;
  clearStatusCache();
  let calls = 0;
  globalThis.fetch = async () => (calls++, new Response("bad request", { status: 400 }));
  try {
    const batch = await batchCfdiStatus([11, 12, 13, 14, 15, 16].map(fieldsFor));
    assert.equal(batch.stopped_after_outage, true);
    // Two requests were already in flight when the first failure landed, so one
    // more may start before the second failure is seen — never more than that.
    assert.ok(batch.queried >= BATCH_OUTAGE_STOP && batch.queried <= BATCH_OUTAGE_STOP + BATCH_CONCURRENCY - 1, `queried ${batch.queried}`);
    assert.equal(batch.unavailable, batch.queried);
    assert.equal(batch.skipped, 6 - batch.queried);
    assert.equal(calls, batch.queried);
    assert.match(batch.items[5].error, /not about the invoice|says nothing about the invoice/);

    // Nothing was remembered: the next batch asks again.
    globalThis.fetch = async () => (calls++, new Response(batchAnswer, { status: 200 }));
    const retry = await batchCfdiStatus([fieldsFor(11)]);
    assert.equal(retry.queried, 1);
    assert.equal(retry.items[0].result.available, true);
  } finally {
    globalThis.fetch = realFetch;
    clearStatusCache();
  }
});

test("an unstamped XML in a batch is rejected locally and costs no request", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (calls++, new Response(batchAnswer, { status: 200 }));
  try {
    const batch = await batchCfdiStatus([{ xml: unstamped }, { xml: "<not-a-cfdi/>" }]);
    assert.equal(calls, 0);
    assert.equal(batch.rejected, 2);
    assert.match(batch.items[0].error, /no Timbre Fiscal Digital/);
    assert.match(batch.items[1].error, /not a CFDI/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the late-2020 alternative spelling of the EFOS field is read too", () => {
  assert.equal(interpret({ VerificacionEFOS: "200" }).validacion_efos, "200");
});

test("every cancellation state has its own explanation", () => {
  const states = [
    ["Cancelado sin aceptación", "cancelado_sin_aceptacion"],
    ["Cancelado con aceptación", "cancelado_con_aceptacion"],
    ["Plazo vencido", "plazo_vencido"],
    ["En proceso", "en_proceso"],
    ["Solicitud rechazada", "solicitud_rechazada"],
    ["", "ninguno"],
  ];
  for (const [raw, expected] of states) {
    const reading = interpret({ EstatusCancelacion: raw });
    assert.equal(reading.cancellation_state, expected);
    assert.ok(reading.cancellation_meaning.length > 10);
  }
});

// --- catalogues ------------------------------------------------------------

test("every catalogue name resolves to a non-empty catalogue", () => {
  for (const name of CATALOG_NAMES) {
    const result = lookupCatalog(name);
    assert.ok(result.total_entries > 0, `${name} is empty`);
    assert.equal(result.match_type, "all");
    assert.equal(result.match_count, result.total_entries);
  }
});

test("an exact code match wins over a text search", () => {
  const result = lookupCatalog("uso_cfdi", "G03");
  assert.equal(result.match_type, "exact");
  assert.equal(result.match_count, 1);
  assert.equal(result.entries[0].label, "Gastos en general");
});

test("leading zeros do not matter when looking up a code", () => {
  const padded = lookupCatalog("forma_pago", "03");
  const bare = lookupCatalog("forma_pago", "3");
  assert.equal(padded.match_type, "exact");
  assert.equal(bare.match_type, "exact");
  assert.deepEqual(padded.entries, bare.entries);
});

test("text search is case- and accent-insensitive", () => {
  const result = lookupCatalog("regimen_fiscal", "confianza");
  assert.equal(result.match_type, "search");
  assert.ok(result.entries.some((e) => e.code === "626"));
  assert.ok(lookupCatalog("estados_curp", "MEXICO").entries.some((e) => e.code === "DF"));
});

test("a query that matches nothing says so instead of returning the catalogue", () => {
  const result = lookupCatalog("impuestos", "zzzz");
  assert.equal(result.match_count, 0);
  assert.equal(result.entries.length, 0);
  assert.ok(result.notes.some((n) => /No entry/.test(n)));
});

test("the bank catalogue always carries its subset caveat", () => {
  assert.ok(lookupCatalog("bancos_clabe", "012").notes.some((n) => /curated subset/.test(n)));
});

// --- identifier reports ----------------------------------------------------

test("XAXX010101000 is valid but does NOT satisfy its check digit", () => {
  const report = reportRfc("xaxx-010101-000");
  assert.equal(report.valid, true);
  assert.equal(report.is_generic, true);
  assert.equal(report.check_digit_satisfied, false);
  // The algorithm asks for a 4; the field must say so, not echo the 0 the SAT wrote.
  assert.equal(report.expected_check_digit, "4");
  assert.ok(report.findings.some((f) => /does NOT satisfy/.test(f.message)));
});

test("XEXX010101000 is generic AND satisfies its check digit", () => {
  const report = reportRfc("XEXX010101000");
  assert.equal(report.valid, true);
  assert.equal(report.is_generic, true);
  assert.equal(report.check_digit_satisfied, true);
});

test("a bad RFC check digit produces a legible error, not just a code", () => {
  const report = reportRfc("GODE561231GR9");
  assert.equal(report.valid, false);
  const checksum = report.errors.find((e) => e.code === "checksum");
  assert.ok(checksum, "expected a checksum error");
  assert.ok(/modulus-11/.test(checksum.message));
});

test("the CURP report decodes state, sex and century", () => {
  const report = reportCurp("BOXW310820HNERXN09");
  assert.equal(report.valid, true);
  assert.equal(report.state_key, "NE");
  assert.equal(report.state_name, "Nacido en el extranjero");
  assert.equal(report.sex, "H");
  assert.equal(report.century_marker, "0");
  // RENAPO: a digit at position 17 means born before 2000, so 31 is 1931 — and
  // the report must say exactly that, never that the marker and date disagree.
  assert.equal(report.birth_date, "1931-08-20");
  assert.ok(report.findings.some((f) => /digit \('0'\), which marks a birth before 2000 — so the year is read as 1931/.test(f.message)));
  assert.ok(!report.findings.some((f) => /disagree/.test(f.message)));
});

test("the CURP century marker is read the right way round for both centuries", () => {
  for (const kind of ["person"]) {
    for (const person of generateTestData(kind, 40).people) {
      const report = reportCurp(person.curp);
      const year = Number(report.birth_date.slice(0, 4));
      const digit = /[0-9]/.test(report.century_marker);
      assert.equal(digit, year < 2000, `${person.curp}: marker '${report.century_marker}' vs ${report.birth_date}`);
      assert.ok(report.findings.some((f) => new RegExp(`read as ${year}`).test(f.message)), person.curp);
    }
  }
});

test("the CLABE report names the bank and keeps the plaza code verbatim", () => {
  const clabe = generateTestData("person", 1).people[0].clabe;
  const report = reportClabe(clabe);
  assert.equal(report.valid, true);
  assert.equal(report.plaza_code, report.normalized.slice(3, 6));
  assert.ok(report.plaza_note.includes("plaza"));
  assert.ok(report.formatted.includes(" "));
});

test("an unknown CLABE bank code is warned about, never given a name", () => {
  // 999 is not a Banxico participant in the bundled subset. Build a CLABE that
  // is otherwise arithmetically correct so the warning is about the name, not
  // about the check digit.
  const base = "99918001234567888";
  const report = reportClabe(base + clabeCheckDigit(base));
  assert.equal(report.bank_name, null);
  assert.ok(report.findings.some((f) => f.severity === "warn" && /not in the bundled/.test(f.message)));
});

test("a Bineo CLABE (bank 165) is valid and named", () => {
  const base = "16518012345678901";
  const report = reportClabe(base + clabeCheckDigit(base));
  assert.equal(report.valid, true);
  assert.equal(report.bank_name, "Bineo");
  assert.ok(!report.findings.some((f) => /not in the bundled/.test(f.message)));
});

test("the CLABE control digit keeps each product's last digit, not its Luhn-style digit sum", () => {
  // 0·3 + 9·7 = 63 → counts 3 → control digit 7. Adding 6 + 3 = 9 would give 1.
  // The example the README and the tool description quote.
  assert.equal(clabeCheckDigit("09000000000000000"), "7");
  const report = reportClabe("090000000000000001");
  assert.equal(report.valid, false);
  assert.equal(report.expected_check_digit, "7");
  assert.ok(report.errors.some((e) => e.code === "checksum" && /63 counts 3/.test(e.message)));
});

test("the NSS report explains the Luhn failure", () => {
  // The Luhn digit over 9211962472 is 1, so 0 is wrong on purpose.
  const report = reportNss("92119624720");
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((e) => e.code === "checksum" && /Luhn/.test(e.message)));
});

test("an empty input is reported as empty rather than crashing", () => {
  for (const report of [reportRfc(""), reportCurp(""), reportClabe(""), reportNss("")]) {
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => e.code === "empty"));
  }
});

// --- generation ------------------------------------------------------------

test("every generated person validates on all four identifiers", () => {
  const result = generateTestData("person", 25);
  assert.equal(result.count, 25);
  assert.equal(result.people.length, 25);
  assert.equal(result.companies.length, 0);
  for (const p of result.people) {
    assert.equal(validateRfc(p.rfc).valid, true, `RFC ${p.rfc}`);
    assert.equal(validateCurp(p.curp).valid, true, `CURP ${p.curp}`);
    assert.equal(validateClabe(p.clabe).valid, true, `CLABE ${p.clabe}`);
    assert.equal(validateNss(p.nss).valid, true, `NSS ${p.nss}`);
  }
});

test("a generated person's RFC and CURP agree on birth date and initials", () => {
  for (const p of generateTestData("person", 20).people) {
    assert.equal(p.rfc.slice(4, 10), p.curp.slice(4, 10), `${p.rfc} vs ${p.curp}`);
    assert.equal(p.rfc.slice(0, 4), p.curp.slice(0, 4), `${p.rfc} vs ${p.curp}`);
  }
});

test("every generated company has a 12-character persona-moral RFC", () => {
  const result = generateTestData("company", 15);
  assert.equal(result.companies.length, 15);
  for (const c of result.companies) {
    const report = validateRfc(c.rfc);
    assert.equal(report.valid, true, `RFC ${c.rfc}`);
    assert.equal(report.kind, "moral");
    assert.equal(validateClabe(c.clabe).valid, true);
  }
});

test("count is clamped to 1-100 instead of throwing", () => {
  assert.equal(generateTestData("person", 0).count, 1);
  assert.equal(generateTestData("person", 5000).count, 100);
});

test("generated data always carries the not-real warning", () => {
  const result = generateTestData("company", 1);
  const warning = result.findings.find((f) => /not taken from any real record/.test(f.message));
  assert.ok(warning, "expected the generated-data warning");
  // It must not promise the impossible: a common-name CURP can match a real one.
  assert.match(warning.message, /coincide with a real person's by chance/);
});

// --- hostile or oversized XML ----------------------------------------------

test("a DOCTYPE is refused before parsing, so no entity trick reaches the parser", () => {
  const withDtd = `<?xml version="1.0"?><!DOCTYPE c [<!ENTITY x "boom">]>${stamped.replace(/^<\?xml[^>]*>/, "")}`;
  assert.throws(() => parseCfdi(withDtd), (err) => err instanceof CfdiParseError && err.reason === "doctype");
});

test("an XML with more elements than the cap is refused unparsed", () => {
  const flood = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4">${"<a/>".repeat(MAX_XML_ELEMENTS + 1)}</cfdi:Comprobante>`;
  assert.throws(() => parseCfdi(flood), (err) => err instanceof CfdiParseError && err.reason === "too_large");
});

test("conceptos beyond the reporting cap are counted but not all returned", () => {
  const one = /<cfdi:Concepto\b[\s\S]*?<\/cfdi:Concepto>/.exec(stamped)[0];
  const many = stamped.replace(one, one.repeat(MAX_REPORTED_CONCEPTOS + 20));
  const doc = parseCfdi(many);
  assert.ok(doc.concepto_count > MAX_REPORTED_CONCEPTOS);
  assert.equal(doc.conceptos.length, MAX_REPORTED_CONCEPTOS);
  assert.equal(doc.conceptos_truncated, true);
  assert.equal(parseCfdi(stamped).conceptos_truncated, false);
});

test("local taxes from the implocal complement count toward the declared total", () => {
  const implocal =
    '<implocal:ImpuestosLocales xmlns:implocal="http://www.sat.gob.mx/implocal" version="1.0" TotaldeRetenciones="0.00" TotaldeTraslados="30.00">' +
    '<implocal:TrasladosLocales ImpLocTrasladado="ISH" TasadeTraslado="3.00" Importe="30.00"/></implocal:ImpuestosLocales>';
  const base = parseCfdi(stamped);
  const withLocal = stamped
    .replace(`Total="${base.total}"`, `Total="${(Number(base.total) + 30).toFixed(2)}"`)
    .replace(/<cfdi:Complemento>/, `<cfdi:Complemento>${implocal}`);
  const doc = parseCfdi(withLocal);
  assert.equal(doc.total_traslados_locales, "30.00");
  assert.equal(doc.arithmetic.matches, true, JSON.stringify(doc.arithmetic));
  // Control: the same total without the complement no longer adds up.
  const withoutLocal = withLocal.replace(implocal, "");
  assert.equal(parseCfdi(withoutLocal).arithmetic.matches, false);
});

// --- other document shapes (synthetic fixtures, SAT generic test RFCs) -------------

const pago20 = readFileSync(join(FIXTURES, "cfdi40-pago20-sintetico.xml"), "utf8");
const cfdi33 = readFileSync(join(FIXTURES, "cfdi33-sintetico.xml"), "utf8");
const retenciones = readFileSync(join(FIXTURES, "retenciones20-sintetico.xml"), "utf8");

test("a CFDI 4.0 with the Pagos 2.0 complement is read, and the unread complement is named", () => {
  const doc = parseCfdi(pago20);
  assert.equal(doc.tipo, "P");
  assert.equal(doc.tipo_label, "Pago");
  assert.equal(doc.stamped, true);
  assert.equal(doc.arithmetic.matches, true);
  const note = doc.findings.find((f) => /does not extract/.test(f.message));
  assert.ok(note, "expected a finding about the unread complement");
  assert.match(note.message, /Pagos/);
  assert.doesNotMatch(note.message, /TimbreFiscalDigital/);
});

test("a stamped CFDI whose only complement is the timbre raises no unread-complement note", () => {
  assert.ok(!parseCfdi(stamped).findings.some((f) => /does not extract/.test(f.message)));
});

test("a CFDI 3.3 is read with a version warning instead of being rejected", () => {
  const doc = parseCfdi(cfdi33);
  assert.equal(doc.version, "3.3");
  assert.equal(doc.total, "116.00");
  assert.equal(doc.arithmetic.matches, true);
  assert.ok(doc.findings.some((f) => f.severity === "warn" && /not 4\.0/.test(f.message)));
});

test("a Retenciones document is named as such and refused", () => {
  assert.throws(
    () => parseCfdi(retenciones),
    (err) => err instanceof CfdiParseError && err.reason === "not_cfdi" && /Retenciones e información de pagos/.test(err.message),
  );
});

test("a leading BOM and surrounding whitespace do not stop a CFDI from parsing", () => {
  assert.equal(parseCfdi(`﻿\n  ${stamped}\n`).total, "1160.00");
});

test("an undefined entity reference is a parser note, never an expansion", () => {
  const doc = parseCfdi(stamped.replace('Descripcion="Desarrollo de sitio web"', 'Descripcion="&xxe;"'));
  assert.ok(!doc.conceptos[0].descripcion.includes("root:"));
  assert.ok(doc.findings.some((f) => /XML parser note/.test(f.message)));
});

test("a DOCTYPE hidden in a comment is refused too", () => {
  const xml = `<!-- <!DOCTYPE x [<!ENTITY a "b">]> -->${stamped.replace(/^<\?xml[^>]*>/, "")}`;
  assert.throws(() => parseCfdi(xml), (err) => err instanceof CfdiParseError && err.reason === "doctype");
});

test("a multi-megabyte attribute is cut in the result and flagged, not echoed whole", () => {
  const huge = stamped.replace('Descripcion="Desarrollo de sitio web"', `Descripcion="${"x".repeat(1_500_000)}"`);
  const doc = parseCfdi(huge);
  assert.ok(doc.conceptos[0].descripcion.length <= MAX_ATTR_CHARS + 1);
  assert.ok(JSON.stringify(doc).length < 100_000);
  assert.ok(doc.findings.some((f) => f.severity === "warn" && /longer than/.test(f.message)));
  assert.ok(!parseCfdi(stamped).findings.some((f) => /longer than/.test(f.message)));
});

test("deeply nested elements neither crash nor hang the reader", () => {
  const depth = 100_000;
  const xml = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0">${"<a>".repeat(depth)}${"</a>".repeat(depth)}</cfdi:Comprobante>`;
  const began = Date.now();
  assert.equal(parseCfdi(xml).version, "4.0");
  assert.ok(Date.now() - began < 5_000);
});

// --- SAT query screening -----------------------------------------------------

test("an RFC with '&' is carried as &amp; in the expression, whichever way it was typed", () => {
  assert.equal(expressionRfc("ñ&a010101aaa"), "Ñ&amp;A010101AAA");
  assert.equal(expressionRfc("Ñ&amp;A010101AAA"), "Ñ&amp;A010101AAA");
  const expression = buildExpression({ rfc_emisor: "Ñ&A010101AAA", rfc_receptor: "XAXX010101000", total: "10", uuid: "5a7b3c1d-9e2f-4a6b-8c0d-1e2f3a4b5c6d" });
  assert.ok(expression.startsWith("?re=Ñ&amp;A010101AAA&rr=XAXX010101000&tt=10.0&id="));
  // The envelope escapes the expression once more, as nodecfdi does.
  assert.ok(buildSoapEnvelope(expression).includes("?re=Ñ&amp;amp;A010101AAA&amp;rr="));
});

test("validateStatusQuery refuses malformed fields before they cost a SAT request", () => {
  const good = { rfc_emisor: "TES150312DX2", rfc_receptor: "XAXX010101000", total: "1160.00", uuid: "5A7B3C1D-9E2F-4A6B-8C0D-1E2F3A4B5C6D" };
  assert.deepEqual(validateStatusQuery(good), []);
  assert.deepEqual(validateStatusQuery({ ...good, rfc_emisor: "Ñ&amp;A010101AAA" }), []);
  for (const [field, value] of [
    ["total", "1,160.00"],
    ["total", "0x10"],
    ["total", "-5"],
    ["uuid", "not-a-uuid"],
    ["rfc_receptor", "ABC"],
  ]) {
    const problems = validateStatusQuery({ ...good, [field]: value });
    assert.equal(problems.length, 1, `${field}=${value}`);
    assert.ok(problems[0].startsWith(field), problems[0]);
  }
});

// --- HTTP transport defaults ---------------------------------------------------

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startHttpServer(env) {
  const port = await freePort();
  const base = { ...process.env };
  for (const key of ["HOST", "ALLOWED_HOSTS", "ALLOWED_ORIGINS", "MCP_AUTH_TOKEN"]) delete base[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...base, TRANSPORT: "http", PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 100 && !/running on http/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
  return { port, log: () => log, stop: () => new Promise((r) => (child.once("exit", r), child.kill("SIGTERM"))) };
}

function post(port, headers = {}, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTP transport binds to loopback and rejects a foreign Host or Origin by default", async () => {
  const srv = await startHttpServer({});
  try {
    assert.match(srv.log(), /http:\/\/127\.0\.0\.1:/);
    assert.equal((await post(srv.port)).status, 200);
    assert.equal((await post(srv.port, { host: "attacker.example" })).status, 403);
    assert.equal((await post(srv.port, { origin: "http://attacker.example" })).status, 403);
  } finally {
    await srv.stop();
  }
});

test("HTTP transport enforces MCP_AUTH_TOKEN and answers parse errors in JSON-RPC", async () => {
  const srv = await startHttpServer({ MCP_AUTH_TOKEN: "s3cret-token" });
  try {
    assert.equal((await post(srv.port)).status, 401);
    assert.equal((await post(srv.port, { authorization: "Bearer s3cret-token" })).status, 200);
    const broken = await post(srv.port, { authorization: "Bearer s3cret-token" }, "{not json");
    assert.equal(broken.status, 400);
    assert.equal(JSON.parse(broken.body).error.code, -32700);
  } finally {
    await srv.stop();
  }
});

test("an invalid PORT stops the HTTP server with a one-line explanation, not a stack trace", async () => {
  for (const bad of ["abc", "3000abc", "0", "70000", "-1", "30.5"]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
      env: { ...process.env, TRANSPORT: "http", PORT: bad },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr.on("data", (c) => (log += c));
    const code = await new Promise((r) => child.once("exit", r));
    assert.equal(code, 1, `PORT=${bad}`);
    assert.match(log, /PORT must be a whole number from 1 to 65535/, `PORT=${bad}`);
    assert.ok(log.includes(`'${bad}'`));
    assert.doesNotMatch(log, /\n\s+at /);
  }
});

test("HTTP transport on a public bind warns when it has no Host allowlist or token", async () => {
  const srv = await startHttpServer({ HOST: "0.0.0.0" });
  try {
    assert.match(srv.log(), /without ALLOWED_HOSTS/);
    assert.match(srv.log(), /without MCP_AUTH_TOKEN/);
  } finally {
    await srv.stop();
  }
});
