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
  CfdiBatchStatusSchema,
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
const unstampedXml = readFileSync(join(ROOT, "test", "fixtures", "cfdi40-sin-timbre.xml"), "utf8");
const CLABE = buildClabe("012");

/** `--offline` (or SMOKE_OFFLINE=1) skips the calls that reach the SAT (cfdi_status), so no request leaves the machine. */
const OFFLINE = process.argv.includes("--offline") || process.env.SMOKE_OFFLINE === "1";

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
    online: true,
    args: { xml: stampedXml },
    schema: CfdiStatusSchema,
    signal: (s) => (s.available ? `SAT says '${s.status.estado}'` : `unavailable: ${s.unavailable_reason?.slice(0, 60)}`),
  },
  {
    // An unstamped XML and a malformed field are both refused before any request,
    // so this call never reaches the SAT.
    tool: "cfdi_batch_status",
    label: "cfdi_batch_status",
    args: { items: [{ xml: unstampedXml }, { rfc_emisor: "ABC", rfc_receptor: "XAXX010101000", total: "1", uuid: "x" }] },
    schema: CfdiBatchStatusSchema,
    signal: (s) => `${s.total} item(s), ${s.rejected} rejected, ${s.queried} sent to the SAT`,
    expect: (s) => (s.rejected === 2 && s.queried === 0 ? null : "both items should be rejected locally"),
  },
  {
    tool: "cfdi_status",
    label: "cfdi_status (fields)",
    online: true,
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

  // Resources and prompts: listed, one read, one rendered.
  const { resources } = await client.listResources();
  const { prompts } = await client.listPrompts();
  console.log(`  resources: ${resources.length}, prompts: ${prompts.map((p) => p.name).join(", ")}`);
  if (resources.length !== 10 || prompts.length !== 3) {
    console.log(`  ❌ expected 10 resources and 3 prompts`);
    failed++;
  }
  const read = await client.readResource({ uri: "mx-fiscal://catalog/uso_cfdi" });
  const catalog = JSON.parse(read.contents[0].text);
  if (catalog.official_name !== "c_UsoCFDI" || !catalog.entries.some((e) => e.code === "G03")) {
    console.log(`  ❌ mx-fiscal://catalog/uso_cfdi did not return c_UsoCFDI with G03`);
    failed++;
  }
  const prompt = await client.getPrompt({ name: "review_cfdi", arguments: { xml: "<x/>" } });
  if (!/parse_cfdi/.test(prompt.messages[0].content.text)) {
    console.log(`  ❌ review_cfdi did not mention parse_cfdi`);
    failed++;
  }

  let passed = 0;
  let planned_calls = 0;
  for (const call of CALLS) {
    if (OFFLINE && call.online) continue;
    planned_calls++;
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
  console.log(`  ${passed} passed, ${failed} failed (of ${planned_calls} calls)${OFFLINE ? " — offline: no SAT request made" : ""}`);
  return { passed, failed, era, planned_calls };
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
  `\n${modern.passed + legacy.passed} passed, ${failures} failed across both eras (${modern.planned_calls} calls each).`,
);
process.exit(failures > 0 ? 1 : 0);
