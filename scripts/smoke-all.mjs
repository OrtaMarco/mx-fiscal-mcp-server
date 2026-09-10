/**
 * Smoke test: start the built server over stdio, call EVERY registered tool
 * through the real MCP protocol, and validate each answer's
 * `structuredContent` against that tool's own Zod output schema.
 *
 * It runs the whole battery **twice**, once per protocol era, because this
 * server is built on the v2 SDK and serves both from one factory:
 *
 *   1. `versionNegotiation: { mode: 'auto' }` → the 2026-07-28 revision
 *      (`getProtocolEra() === 'modern'`).
 *   2. no options at all → the 2025 `initialize` handshake (`'legacy'`),
 *      which is what Claude Desktop, Claude Code and Cursor speak today.
 *
 * A regression that only shows up on one era (a schema the modern codec
 * rejects, a tool that leans on session state) fails here rather than in
 * somebody's client.
 *
 *   npm run smoke
 *
 * `cfdi_status` is the only call that leaves the machine. Its fixture is a
 * made-up but well-formed invoice, so the SAT answers "No Encontrado" — and if
 * the SAT is down, `available: false` is accepted, as long as the payload still
 * validates. Everything else is offline and deterministic.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CatalogSchema,
  CfdiSchema,
  CfdiStatusSchema,
  ClabeSchema,
  CurpSchema,
  NssSchema,
  RfcSchema,
  TestDataSchema,
} from "../dist/schemas.js";
import { buildClabe } from "mx-identifiers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stampedXml = readFileSync(join(ROOT, "test", "fixtures", "cfdi40-timbrado.xml"), "utf8");
const CLABE = buildClabe("012");

/**
 * One entry per call: the tool, its arguments, the schema its
 * `structuredContent` must satisfy, and a one-line signal to print.
 */
const CALLS = [
  {
    tool: "validate_rfc",
    args: { value: "GODE561231GR8" },
    schema: RfcSchema,
    signal: (s) => `valid=${s.valid} kind=${s.kind}`,
  },
  {
    tool: "validate_rfc",
    label: "validate_rfc (XAXX)",
    args: { value: "XAXX010101000" },
    schema: RfcSchema,
    signal: (s) => `generic=${s.is_generic} check_digit=${s.check_digit_satisfied}`,
    expect: (s) => (s.is_generic && s.check_digit_satisfied === false ? null : "XAXX must be generic with an unsatisfied check digit"),
  },
  {
    tool: "validate_curp",
    args: { value: "BOXW310820HNERXN09" },
    schema: CurpSchema,
    signal: (s) => `valid=${s.valid} state=${s.state_name}`,
  },
  {
    tool: "validate_clabe",
    args: { value: CLABE },
    schema: ClabeSchema,
    signal: (s) => `valid=${s.valid} bank=${s.bank_name}`,
  },
  {
    tool: "validate_nss",
    args: { value: "92119624721" },
    schema: NssSchema,
    signal: (s) => `valid=${s.valid}`,
  },
  {
    tool: "generate_test_data",
    args: { kind: "person", count: 3 },
    schema: TestDataSchema,
    signal: (s) => `${s.people.length} person(s)`,
    expect: (s) => (s.people.length === 3 ? null : "expected 3 people"),
  },
  {
    tool: "parse_cfdi",
    args: { xml: stampedXml },
    schema: CfdiSchema,
    signal: (s) => `v${s.version} total=${s.total} stamped=${s.stamped} conceptos=${s.concepto_count}`,
    expect: (s) => (s.stamped && s.concepto_count === 2 ? null : "expected a stamped invoice with 2 line items"),
  },
  {
    tool: "cfdi_status",
    label: "cfdi_status (xml)",
    args: { xml: stampedXml },
    schema: CfdiStatusSchema,
    signal: (s) => (s.available ? `SAT says '${s.status.estado}'` : `unavailable: ${s.unavailable_reason?.slice(0, 60)}`),
  },
  {
    tool: "cfdi_status",
    label: "cfdi_status (fields)",
    args: {
      rfc_emisor: "TES150312DX2",
      rfc_receptor: "PELJ900521DK2",
      total: "1160.00",
      uuid: "5A7B3C1D-9E2F-4A6B-8C0D-1E2F3A4B5C6D",
    },
    schema: CfdiStatusSchema,
    signal: (s) => (s.available ? `SAT says '${s.status.estado}'` : `unavailable: ${s.unavailable_reason?.slice(0, 60)}`),
  },
  {
    tool: "sat_catalog_lookup",
    args: { catalog: "uso_cfdi", query: "G03" },
    schema: CatalogSchema,
    signal: (s) => `${s.match_count}/${s.total_entries} (${s.match_type})`,
    expect: (s) => (s.match_type === "exact" && s.match_count === 1 ? null : "G03 should be an exact single match"),
  },
];

async function connect(options) {
  const client = new Client({ name: "mx-fiscal-smoke", version: "1.0.0" }, options);
  await client.connect(
    new StdioClientTransport({ command: "node", args: [join(ROOT, "dist", "index.js")], stderr: "ignore" }),
  );
  return client;
}

async function runEra(name, options) {
  console.log(`\n── ${name} era ${"─".repeat(Math.max(0, 44 - name.length))}`);
  const client = await connect(options);
  const era = client.getProtocolEra() ?? "(unreported)";
  console.log(`  negotiated era: ${era}`);

  const { tools } = await client.listTools();
  const registered = new Set(tools.map((t) => t.name));
  const planned = new Set(CALLS.map((c) => c.tool));
  console.log(`  registered tools: ${tools.length} (${[...registered].join(", ")})`);

  let failed = 0;
  for (const name of registered) {
    if (!planned.has(name)) {
      console.log(`  ⚠️  ${name} is registered but not covered by this smoke test`);
      failed++;
    }
  }
  for (const name of planned) {
    if (!registered.has(name)) {
      console.log(`  ⚠️  ${name} is in the smoke test but NOT registered`);
      failed++;
    }
  }

  // Every tool must declare an outputSchema and be flagged read-only.
  for (const tool of tools) {
    if (!tool.outputSchema) {
      console.log(`  ❌ ${tool.name} declares no outputSchema`);
      failed++;
    }
    if (tool.annotations?.readOnlyHint !== true) {
      console.log(`  ❌ ${tool.name} is not annotated readOnlyHint: true`);
      failed++;
    }
  }

  let passed = 0;
  for (const call of CALLS) {
    const label = call.label ?? call.tool;
    const began = Date.now();
    try {
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      const ms = Date.now() - began;

      if (result.isError) {
        console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  error: ${(result.content?.[0]?.text ?? "").slice(0, 120)}`);
        failed++;
        continue;
      }
      if (!result.structuredContent) {
        console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  no structuredContent returned`);
        failed++;
        continue;
      }

      const parsed = call.schema.safeParse(result.structuredContent);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.log(
          `  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  schema mismatch at ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
        failed++;
        continue;
      }

      const complaint = call.expect?.(parsed.data);
      if (complaint) {
        console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  ${complaint}`);
        failed++;
        continue;
      }

      console.log(`  ✅ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  ${call.signal(parsed.data)}`);
      passed++;
    } catch (err) {
      const ms = Date.now() - began;
      console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  threw: ${String(err.message).slice(0, 160)}`);
      failed++;
    }
  }

  await client.close();
  console.log(`  ${passed} passed, ${failed} failed (of ${CALLS.length} calls)`);
  return { passed, failed, era };
}

const modern = await runEra("modern (2026-07-28)", { versionNegotiation: { mode: "auto" } });
const legacy = await runEra("legacy (2025 initialize)", undefined);

let failures = modern.failed + legacy.failed;
if (modern.era !== "modern") {
  console.log(`\n❌ auto negotiation landed on '${modern.era}', expected 'modern'`);
  failures++;
}
if (legacy.era !== "legacy") {
  console.log(`\n❌ the default client landed on '${legacy.era}', expected 'legacy'`);
  failures++;
}

console.log(
  `\n${modern.passed + legacy.passed} passed, ${failures} failed across both eras (${CALLS.length} calls each).`,
);
process.exit(failures > 0 ? 1 : 0);
