# mx-fiscal-mcp-server

> An [MCP](https://modelcontextprotocol.io) server that gives an AI agent **Mexican tax and banking** capabilities — validate RFC, CURP, CLABE and NSS with real check digits, read a CFDI 4.0 invoice, ask the SAT whether it is still live, and look up the SAT's code tables. **No API keys, no CSD certificate, no PAC contract.**

[![ci](https://github.com/OrtaMarco/mx-fiscal-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/OrtaMarco/mx-fiscal-mcp-server/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Ask Claude *"read this invoice and tell me whether it's still valid"* and it parses
the XML, labels every SAT code, checks both RFCs and the arithmetic, and queries
the SAT's public status service — instead of you opening three web tools.

```
> Read this CFDI and check it at the SAT

  parse_cfdi(xml="<cfdi:Comprobante …>")

  CFDI A-1042 — 1160.00 MXN
  ✅ Stamped · version 4.0 · Ingreso
  Emisor:   TES150312DX2 ✅  601 — General de Ley Personas Morales
  Receptor: PELJ900521DK2 ✅  G03 — Gastos en general
  ✅ Totals add up: subtotal − discount + transferred − withheld = total

  cfdi_status(xml="<cfdi:Comprobante …>")

  CFDI status — Vigente
  ✅ The invoice exists in the SAT's records and has not been cancelled.
  Es cancelable: Cancelable con aceptación
  EFOS: returned 200 — the issuer is NOT on the SAT's definitive 69-B list.
```

---

## Why this exists

Mexican electronic invoicing has two halves, and only one of them was served.

**Building and stamping** a CFDI needs a CSD certificate and a contract with a PAC.
That half already has tooling — [`mcp-cfdi-mx`](https://github.com/cmendezs/mcp-cfdi-mx)
(Python) does it, and this server deliberately does not compete with it.

**Reading** is the other half, and it needs nothing: the check-digit algorithms are
public, the SAT's catalogues are public, and the invoice status service behind the QR
code on every printed invoice is public and unauthenticated. Yet an agent asked to
validate an RFC will happily invent a regex that rejects `XAXX010101000` — the RFC of
every invoice issued to the general public — because that one does not satisfy its own
check digit. This server is the read half, done carefully.

The arithmetic comes from [`mx-identifiers`](https://github.com/OrtaMarco/mx-identifiers)
(MIT, zero dependencies, 101 tests against public vectors); the CFDI reader is ported
from the tool running at [ortamarco.me](https://ortamarco.me/herramientas/lector-cfdi/);
the SOAP envelope was read out of [`nodecfdi/sat-estado-cfdi`](https://github.com/nodecfdi/sat-estado-cfdi)
rather than guessed. It is the third of three read-only, key-free MCP servers alongside
[`domain-security-mcp-server`](https://github.com/OrtaMarco/domain-security-mcp-server)
and [`seo-geo-mcp-server`](https://github.com/OrtaMarco/seo-geo-mcp-server).

## Tools

### Identifiers

| Tool | What it does |
|---|---|
| `validate_rfc` | RFC for individuals (13 chars) and companies (12), full modulus-11 check digit, parsed fields, birth/incorporation date. Flags the SAT generics and says which of them satisfies the arithmetic |
| `validate_curp` | 18-character CURP with the base-37 check digit; decodes birth date, sex, state (RENAPO keys, *not* INEGI/ISO) and the century marker |
| `validate_clabe` | 18-digit CLABE with the correct 3-7-1 control digit — each product reduced modulo 10 **before** summing, which is the step most implementations skip — plus the Banxico bank and the plaza code |
| `validate_nss` | 11-digit IMSS number with its Luhn digit, split into subdelegación / registration year / birth year / serial |
| `generate_test_data` ⭐ | 1-100 coherent fake people or companies: the RFC and CURP derive from the same name and birth date, the CLABE's bank is a real participant, every check digit holds |

### CFDI

| Tool | What it does |
|---|---|
| `parse_cfdi` ⭐ | CFDI 4.0 XML → JSON: header, issuer, receiver, every line item with transferred and withheld taxes, tax totals, and the Timbre Fiscal Digital (or `null`). Labels every catalogue code, validates both RFCs, checks the totals arithmetic. Walks the document by local name, so any PAC's namespace prefixes work |
| `cfdi_status` ⭐ | Queries the SAT's public `ConsultaCFDIService` SOAP endpoint: Estado, EsCancelable, EstatusCancelación and ValidaciónEFOS, each with its meaning in plain words. Takes the four key fields **or** the whole XML. Fail-soft: 10 s timeout, one retry, `available: false` on failure — never an exception |

### Catalogues

| Tool | What it does |
|---|---|
| `sat_catalog_lookup` | Nine bundled code tables — `regimen_fiscal`, `uso_cfdi`, `forma_pago`, `metodo_pago`, `tipo_comprobante`, `objeto_imp`, `impuestos`, `bancos_clabe`, `estados_curp` — by exact code (leading zeros ignored) or accent-insensitive text search. Never touches the network |

Every tool is **read-only**, declares an `outputSchema` and returns `structuredContent`
(validated by the SDK) alongside human-readable Markdown (default) or JSON
(`response_format="json"`).

## Honesty notes

These are surfaced in the tool output, not buried here:

- **Structurally valid is not registered.** A check digit that adds up says the string
  is well-formed and nothing more. Only the SAT can say an RFC is registered; only
  RENAPO that a CURP belongs to a person. This server never asks either, and its
  wording never implies it did.
- **`XAXX010101000` does not satisfy its own check digit.** The SAT assigned the
  general-public RFC by decree and the modulus-11 algorithm asks for a `4` where the
  SAT wrote a `0`. `XEXX010101000` (foreign residents) *does* satisfy it. The tools
  report `is_generic` and `check_digit_satisfied` as separate fields rather than
  collapsing both into "valid".
- **Reading a CFDI is not verifying it.** `parse_cfdi` does not check the digital
  signature. A perfectly parseable invoice can be cancelled, or fabricated wholesale.
- **An unreachable SAT is not an invalid invoice.** The status endpoint publishes no
  rate limit, no SLA and no status page, and it goes down. `cfdi_status` degrades to
  `available: false` with the reason — a statement about the SAT, never about the
  document.
- **The bank list is a subset.** `bancos_clabe` carries the main Banxico participants,
  not the full catalogue; an unknown code is reported as unknown rather than given an
  invented name. The plaza catalogue is not bundled at all, so the plaza code is
  returned verbatim.
- **The EFOS mapping is an interpretation.** The SAT documents neither the
  `ValidacionEFOS` code table nor the field itself. `200`/`201` meaning "not on the
  69-B list" is the mapping `phpcfdi` and `nodecfdi` both use, and it is labelled as
  such. An empty field is reported as `unknown`, never as "listed".

## Protocol

Built on the **v2 MCP SDK**, so it speaks the **2026-07-28** revision (`server/discover`,
no `initialize`, per-request `_meta` envelope) **and still serves 2025-era clients** —
Claude Desktop, Claude Code and Cursor — from the same server factory. The entry points
own the era decision: `serveStdio(factory)` on stdio, `createMcpHandler(factory)` over
HTTP with the default `legacy: 'stateless'`. There is no session state and no
`Mcp-Session-Id` in either direction. `npm run smoke` exercises every tool on **both**
eras and asserts the negotiated era of each connection.

Because the tool list is a compile-time constant, `tools/list` and `server/discover`
advertise a real one-hour `ttlMs` with `cacheScope: 'public'` on 2026-era connections
instead of the SDK's conservative `ttlMs: 0`.

## Install

```bash
git clone https://github.com/OrtaMarco/mx-fiscal-mcp-server.git
cd mx-fiscal-mcp-server
npm install
npm run build
```

## Use it with Claude Code

```bash
claude mcp add mx-fiscal -- node /absolute/path/to/mx-fiscal-mcp-server/dist/index.js
```

## Use it with Claude Desktop

Add to `claude_desktop_config.json` (see [`examples/`](./examples/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "mx-fiscal": {
      "command": "node",
      "args": ["/absolute/path/to/mx-fiscal-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop, then ask: *"Generate 10 Mexican customers with valid RFC and CURP for my seed file."*

## Use it with Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), same shape:

```json
{
  "mcpServers": {
    "mx-fiscal": {
      "command": "node",
      "args": ["/absolute/path/to/mx-fiscal-mcp-server/dist/index.js"]
    }
  }
}
```

## Self-host (HTTP transport)

The same server speaks stateless **Streamable HTTP** for remote or multi-client use —
handy behind a reverse proxy such as Coolify or Traefik.

```bash
TRANSPORT=http PORT=3000 npm start
# POST JSON-RPC to http://localhost:3000/mcp   ·   health at /healthz
```

Or with Docker:

```bash
docker build -t mx-fiscal-mcp .
docker run -p 3000:3000 -e TRANSPORT=http mx-fiscal-mcp
```

Set `ALLOWED_ORIGINS=https://your.app` to enable Origin-based DNS-rebinding protection
(leave empty when a trusted proxy already restricts access).

## Develop

```bash
npm run dev        # tsx watch (stdio)
npm run typecheck  # tsc --noEmit
npm test           # 41 deterministic offline unit tests
npm run smoke      # every tool over the real protocol, on BOTH eras
npm run inspect    # MCP Inspector against the built server
npm run build      # type-check + emit dist/
```

## How it works

```
src/
├── index.ts        # transport selection: serveStdio | createMcpHandler + Express
├── server.ts       # the server FACTORY — registers every tool, holds the instructions
├── schemas.ts      # Zod 4 outputSchema for each tool
├── constants.ts    # the single external host, timeouts, limits
├── format.ts       # markdown/JSON response shaping, findings
├── core/           # pure logic, no MCP coupling — reusable & testable
│   ├── identifiers.ts # reporting layer over mx-identifiers (errors, labels, findings)
│   ├── cfdi.ts        # the CFDI 4.0 reader, ported 1:1 from the web tool
│   ├── sat.ts         # SOAP envelope, expression builder, response interpretation
│   ├── catalogs.ts    # the nine code tables + lookup
│   └── testdata.ts    # fixture generation
└── tools/          # thin MCP wrappers (Zod schemas, descriptions, formatting)
```

The `core/` layer carries no MCP types, so the same logic backs both this server and a
web UI. All the check-digit arithmetic lives in `mx-identifiers` and is not
reimplemented here.

**Network surface:** exactly one host, `consultaqr.facturaelectronica.sat.gob.mx`,
hardcoded in `constants.ts`. No tool accepts a URL from the caller, so there is no
SSRF surface to guard. The other seven tools make no network calls at all.

---

## En español

Un servidor MCP que le da a un agente de IA las capacidades fiscales mexicanas que
todo el mundo acaba reimplementando mal: validar **RFC, CURP, CLABE y NSS** con sus
dígitos verificadores de verdad, **leer un CFDI 4.0** en XML, **consultar su estado en
el SAT** y buscar en los **catálogos** del SAT. Sin API keys, sin CSD y sin PAC.

**Esto es la mitad de LECTURA.** Para construir y sellar un CFDI hace falta un
certificado de sello digital y un PAC, y eso ya lo cubre
[`mcp-cfdi-mx`](https://github.com/cmendezs/mcp-cfdi-mx) (Python). Este servidor no
compite con él: lo complementa.

Lo que sí hace bien y casi nadie:

- **`XAXX010101000` no satisface su propio dígito verificador.** El SAT lo asignó por
  decreto y el módulo 11 pide un `4` donde el SAT puso un `0`. `XEXX010101000` (residentes
  en el extranjero) sí lo satisface. Por eso tantos formularios rechazan las facturas al
  público en general. Las tools devuelven `is_generic` y `check_digit_satisfied` por
  separado.
- **El dígito de control de la CLABE reduce cada producto módulo 10 *antes* de sumar.**
  Las implementaciones que suman primero, al estilo Luhn, aceptan y rechazan cuentas
  equivocadas.
- **Las claves de entidad de la CURP son de RENAPO**, no de INEGI ni ISO 3166-2:MX.
  `DF` es Ciudad de México, `MC` es Estado de México, `NE` es nacido en el extranjero.
- **El servicio del SAT se cae y no publica límite de tasa.** `cfdi_status` degrada a
  `available: false` con el motivo; nunca lanza una excepción, y nunca hay que leer un
  fallo del SAT como "la factura es inválida".
- **Estructuralmente válido no es dado de alta.** Que el dígito cuadre dice que la cadena
  está bien formada, nada más.

El motor aritmético es [`mx-identifiers`](https://github.com/OrtaMarco/mx-identifiers)
(MIT, cero dependencias); el lector de CFDI viene de la herramienta que corre en
[ortamarco.me](https://ortamarco.me/herramientas/lector-cfdi/); el sobre SOAP se leyó
del código de [`nodecfdi/sat-estado-cfdi`](https://github.com/nodecfdi/sat-estado-cfdi),
no se inventó.

Habla la revisión **2026-07-28** del protocolo y sigue atendiendo a los clientes de 2025
(Claude Desktop, Claude Code, Cursor) desde la misma factoría de servidor.

## License

MIT © [Marco Orta](https://ortamarco.me)
