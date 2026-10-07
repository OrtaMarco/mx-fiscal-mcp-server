/**
 * MCP resources: the bundled code tables, readable without a tool call.
 *
 * `mx-fiscal://catalogs` indexes them; `mx-fiscal://catalog/<name>` is one table
 * in the same JSON shape `sat_catalog_lookup` returns for a whole catalogue.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { CATALOG_NAMES, lookupCatalog } from "./core/catalogs.js";

const JSON_MIME = "application/json";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "catalogs",
    "mx-fiscal://catalogs",
    {
      title: "Bundled SAT / Banxico / RENAPO catalogues",
      description: "Index of the nine code tables this server bundles, with what each one is and where its codes appear.",
      mimeType: JSON_MIME,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: JSON_MIME,
          text: JSON.stringify(
            CATALOG_NAMES.map((name) => {
              const c = lookupCatalog(name);
              return {
                catalog: name,
                uri: `mx-fiscal://catalog/${name}`,
                official_name: c.official_name,
                authority: c.authority,
                used_in: c.used_in,
                entries: c.total_entries,
              };
            }),
            null,
            2,
          ),
        },
      ],
    }),
  );

  for (const name of CATALOG_NAMES) {
    const meta = lookupCatalog(name);
    server.registerResource(
      `catalog-${name}`,
      `mx-fiscal://catalog/${name}`,
      {
        title: `${meta.official_name} (${meta.authority})`,
        description: `${meta.description} Used in: ${meta.used_in}.`,
        mimeType: JSON_MIME,
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(lookupCatalog(name), null, 2) }],
      }),
    );
  }
}
