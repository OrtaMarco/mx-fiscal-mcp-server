/**
 * Shared plumbing for the MCP tool wrappers.
 */

import * as z from "zod/v4";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { responseFormatField } from "../format.js";

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
