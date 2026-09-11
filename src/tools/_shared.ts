/**
 * Shared plumbing for the MCP tool wrappers.
 */

import * as z from "zod/v4";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { fail, responseFormatField } from "../format.js";

/**
 * Every tool in this server reads: four of them are pure computation over the
 * bundled catalogues, one generates fake data, one parses a string, and one
 * makes a single idempotent GET-shaped query to the SAT. None writes anywhere.
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** `cfdi_status` is the only tool that leaves the process. */
export const READ_ONLY_NETWORK: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** The standard "one identifier in" input shape. */
export function identifierInput(description: string) {
  return z.object({
    value: z.string().min(1).describe(description),
    response_format: responseFormatField,
  });
}

/** Render a `label: value` line only when the value is present. */
export function optionalLine(label: string, value: string | null | undefined): string[] {
  return value ? [`- **${label}:** ${value}`] : [];
}

/**
 * XML parsing is synchronous and memory-hungry, and cfdi_status spends a request
 * at the SAT. Over HTTP many callers share one process, so these run a few at a
 * time and a caller beyond that is told to retry instead of queueing unbounded.
 */
const MAX_HEAVY_CALLS = Number(process.env.MAX_CONCURRENT_CFDI) > 0 ? Number(process.env.MAX_CONCURRENT_CFDI) : 4;
let heavyInFlight = 0;

export async function withHeavySlot(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  if (heavyInFlight >= MAX_HEAVY_CALLS) {
    return fail(`Error: the server is already processing ${MAX_HEAVY_CALLS} CFDI requests; retry in a moment.`);
  }
  heavyInFlight++;
  try {
    return await run();
  } finally {
    heavyInFlight--;
  }
}
