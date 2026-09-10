/**
 * Builds the MCP server instance and registers every tool.
 *
 * This is a **factory**, not a singleton: both v2 entry points
 * (`serveStdio` and `createMcpHandler`) take a factory and call it once per
 * connection (stdio) or once per request (HTTP), which is what lets one code
 * path serve both the 2026-07-28 revision and 2025-era clients.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerIdentifierTools } from "./tools/identifiers.js";
import { registerCfdiTools } from "./tools/cfdi.js";
import { registerCatalogTools } from "./tools/catalogs.js";

const INSTRUCTIONS = `Mexican tax and banking toolkit. Every tool is read-only and needs no API key, no CSD certificate and no PAC contract. Eight of the nine are pure computation over bundled catalogues and never touch the network; only \`cfdi_status\` leaves the process, and it talks to exactly one hardcoded host — the SAT's public status service.

Guidance:
- Identifier questions: \`validate_rfc\`, \`validate_curp\`, \`validate_clabe\`, \`validate_nss\`. Each returns the normalised value, the parsed fields and a legible reason for every failure.
- Fixtures, seeds and demos: \`generate_test_data\`. Its output satisfies every check digit and belongs to nobody.
- An invoice XML in hand: \`parse_cfdi\` reads it (labels every catalogue code, validates both RFCs, checks the arithmetic); \`cfdi_status\` asks the SAT whether it is still live. Prefer passing the whole \`xml\` to \`cfdi_status\` over typing the four fields — a mis-formatted total is the commonest cause of a false 'No Encontrado'.
- Code tables: \`sat_catalog_lookup\` covers régimen fiscal, uso CFDI, forma and método de pago, tipo de comprobante, objeto de impuesto, impuestos, CLABE banks and CURP states.

Four distinctions worth carrying into your answers:

1. **Structurally valid is not registered.** A check digit that adds up says the string is well-formed, nothing more. Only the SAT can say an RFC is registered, only RENAPO that a CURP belongs to someone. This server never asks either, and neither should your wording.
2. **XAXX010101000 does not satisfy its own check digit.** The SAT assigned the general-public RFC by decree and the modulus-11 algorithm disagrees with it. XEXX010101000 (foreign residents) does satisfy it. Say which case you are in rather than "it's valid".
3. **Reading a CFDI is not verifying it.** \`parse_cfdi\` reads what the XML says; it does not check the digital signature. A perfectly parseable invoice can be cancelled, or invented outright.
4. **An unreachable SAT is not an invalid invoice.** \`cfdi_status\` returns \`available: false\` when the service times out or refuses. That is a statement about the SAT, which publishes no rate limit and no SLA for this endpoint. Report the check as not performed — never as a negative result.

This is the read half of Mexican electronic invoicing. Building and stamping a CFDI needs a CSD certificate and a PAC, and no tool here does it.

All tools accept response_format='json' for the full structured payload instead of the default markdown.`;

/**
 * Create a fully-registered server instance.
 *
 * Tool registration order is deliberate and stable: `tools/list` returns them
 * in this order on every connection, so a client that caches the list (see the
 * `cacheHints` below) never sees it shuffle.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      // The tool list is a compile-time constant here — no dynamic
      // registration, no feature flags — so on the 2026-07-28 revision we can
      // honestly advertise a real TTL instead of the SDK's conservative
      // `ttlMs: 0`. `public` is safe because the advertisement carries nothing
      // user-specific. 2025-era responses never carry these fields.
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );

  registerIdentifierTools(server); // validate_rfc/curp/clabe/nss + generate_test_data
  registerCfdiTools(server); // parse_cfdi + cfdi_status
  registerCatalogTools(server); // sat_catalog_lookup

  return server;
}
