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
} from "../dist/core/sat.js";
import { lookupCatalog, CATALOG_NAMES } from "../dist/core/catalogs.js";
import { reportClabe, reportCurp, reportNss, reportRfc } from "../dist/core/identifiers.js";
import { generateTestData } from "../dist/core/testdata.js";
import { MAX_REPORTED_CONCEPTOS, MAX_XML_ELEMENTS } from "../dist/constants.js";
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

test("an EFOS code that is neither 200 nor 201 means listed", () => {
  assert.equal(interpret({ ValidacionEFOS: "100" }).efos_state, "listed");
  assert.equal(interpret({ ValidacionEFOS: "201" }).efos_state, "not_listed");
});

test("an empty EFOS field is 'unknown', never 'listed'", () => {
  // The SAT returns it blank on a 'No Encontrado'. Reading that as "the issuer
  // is on the 69-B list" would be a serious accusation drawn from silence.
  const reading = interpret({ Estado: "No Encontrado", ValidacionEFOS: "" });
  assert.equal(reading.efos_state, "unknown");
  assert.ok(/no EFOS field/.test(reading.efos_meaning));
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

test("HTTP transport on a public bind warns when it has no Host allowlist or token", async () => {
  const srv = await startHttpServer({ HOST: "0.0.0.0" });
  try {
    assert.match(srv.log(), /without ALLOWED_HOSTS/);
    assert.match(srv.log(), /without MCP_AUTH_TOKEN/);
  } finally {
    await srv.stop();
  }
});
