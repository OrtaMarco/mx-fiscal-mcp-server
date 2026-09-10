/**
 * Shared response-formatting helpers for MCP tool handlers.
 *
 * Every data-returning tool supports two output formats:
 *   - "markdown" (default): human-readable summary.
 *   - "json": the complete structured payload.
 *
 * Schemas are authored with Zod 4 through the `zod/v4` subpath, which is what
 * the v2 SDK requires: Zod 3 registers without complaining and then fails on
 * the first `tools/list`.
 */

import * as z from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { CHARACTER_LIMIT } from "./constants.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/** Reusable Zod field so every tool exposes the same `response_format` option. */
export const responseFormatField = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe(
    "Output format: 'markdown' for a human-readable summary (default) or 'json' for the full structured payload.",
  );

/** Truncate oversized text so a single tool call never floods the context window. */
export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n…[truncated ${text.length - CHARACTER_LIMIT} characters — request response_format='json' or a narrower query for the full payload]`
  );
}

/** A successful tool result carrying a single text block. */
export function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

/** An error tool result. Messages should be actionable (what went wrong + next step). */
export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

/**
 * Render `data` as the tool's text content (pretty JSON or the markdown
 * renderer) AND attach it as `structuredContent` for clients that consume the
 * tool's `outputSchema`. The SDK validates it against that schema, so any drift
 * between `core/` and `schemas.ts` fails loudly instead of silently.
 */
export function respond(
  data: unknown,
  format: ResponseFormat,
  toMarkdown: () => string,
): CallToolResult {
  const text = format === "json" ? JSON.stringify(data, null, 2) : toMarkdown();
  return {
    content: [{ type: "text", text: truncate(text) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export type Severity = "pass" | "warn" | "fail" | "info";

/** A single observation about the input. Shared across every core module. */
export interface Finding {
  severity: Severity;
  message: string;
}

export function severityGlyph(severity: Severity): string {
  if (severity === "pass") return "✅";
  if (severity === "warn") return "⚠️";
  if (severity === "info") return "ℹ️";
  return "❌";
}

/** Render a list of findings as markdown bullet lines, worst first. */
export function renderFindings(findings: Finding[]): string {
  const order: Record<Severity, number> = { fail: 0, warn: 1, pass: 2, info: 3 };
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `${severityGlyph(f.severity)} ${f.message}`)
    .join("\n");
}

/** Render a `label: value` markdown line, hiding empty values behind an em dash. */
export function field(label: string, value: string | null | undefined): string {
  return `- **${label}:** ${value === null || value === undefined || value === "" ? "—" : value}`;
}

/** Render a small markdown table. */
export function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}
