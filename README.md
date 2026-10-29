# @pipeworx/sdmx-structure

Dataflow dimensions and code lists — "what do the codes in this dataset mean" —
for any SDMX 2.1 statistical registry: Eurostat, OECD, the European Central
Bank, the UN Statistics Division (via the data.un.org SDMX hub), the IMF, the
Bank for International Settlements, ILOSTAT, and the Australian Bureau of
Statistics. This is the STRUCTURE half of SDMX, distinct from pulling
observations — use it to decode a dimension's codes or to learn the key
order a registry's own get_data tool needs.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `sdmx_dataflow_structure(registry, dataflow, agency?, version?, max_codes_per_dimension?)`
  — the ordered dimensions of one dataflow, each with its codelist's
  code→label pairs (capped per dimension, with a truncation flag and the
  true total count). Resolves the dataflow's real DSD (Data Structure
  Definition) reference rather than assuming the dataflow id equals the DSD
  id — they differ for many flows (Eurostat's `UNE_RT_M` dataflow v1.0 points
  at DSD `UNE_RT_M` v155.0; BIS's `WS_CBPOL` dataflow points at a differently
  named DSD, `BIS_CBPOL`).
- `sdmx_codelist(registry, id, agency?, version?, filter?, limit?)` — one
  codelist's code→label pairs by id alone, with no dataflow needed. Useful
  once you already know a codelist id (from `sdmx_dataflow_structure`'s
  `codelist` field, or from documentation) and just want the codes, optionally
  filtered by a substring.
- `sdmx_find_dataflow(registry, query, agency?, limit?)` — keyword search
  across a registry's dataflow catalogue by id or name, to find the id to pass
  to `sdmx_dataflow_structure`.

## Registries

| `registry` | Source | Structure format | Default agency |
|---|---|---|---|
| `eurostat` | Eurostat | XML only (confirmed live — every JSON Accept/format combination 406s) | `ESTAT` |
| `oecd` | OECD | JSON | `all` |
| `ecb` | European Central Bank | XML only | `ECB` |
| `unsd` | UN Statistics Division (data.un.org SDMX hub) | JSON | `all` |
| `imf` | IMF | JSON | `all` |
| `bis` | Bank for International Settlements | JSON | `BIS` |
| `ilo` | ILOSTAT | JSON | `ILO` |
| `abs` | Australian Bureau of Statistics | JSON | `ABS` |

**OECD, IMF and UNSD default to agency `all`, not a single agency — this is
load-bearing, not a placeholder.** All three registries split their catalogue
across many maintaining sub-agencies and there is no single agency id that
covers it:

- **OECD**: there is no agency literally called `"OECD"` — every dataflow is
  published under a directorate (`OECD.SDD.NAD`, `OECD.ELS.JAI`,
  `OECD.EDU.IMEP`, ...; 52 distinct agency ids observed live, some mirroring
  in ESTAT and IAEG-SDGs flows too). Querying agency `"OECD"` 404s with
  `"No Results Found"` on both the catalogue listing and a single-dataflow
  lookup — this is the live defect fleet #2839's follow-up caught
  (`sdmx_find_dataflow({registry:"oecd", query:"unemployment"})` 404ing).
- **IMF**: ten sub-agencies (`IMF.STA`, `IMF.MCD`, `IMF.SPR`, `IMF.AFR`,
  `IMF.MCM`, `IMF.FAD`, `IMF.WHD`, `IMF.APD`, `IMF.RES`, plus the external
  `ISORA`). `IMF.STA` alone 200s — which is why this looked fine at first —
  but covers only 190 of 223 dataflows; the other 33 are every regional
  economic outlook (`APDREO`, `AFRREO`, `WHDREO`, ...) and the fiscal affairs
  dataflows.
- **UNSD**: the hub mirrors ESTAT, IAEG-SDGs, UIS and World Bank dataflows
  under THEIR agency ids alongside UNSD's own ~4. Querying agency `"UNSD"`
  200s but returns only UNSD's own flows (1.4KB observed) where `"all"`
  returns the whole hub (4.4KB, ~15 dataflows).

`"all"` resolves a SINGLE dataflow lookup identically to the dataflow's real
sub-agency for all three (verified side by side, byte-identical response, for
an OECD.SDD.NAD flow, an IMF.APD flow and an ESTAT-owned UNSD-hub flow) — so
there is no coverage cost to defaulting to it. Pass `agency` only to narrow a
search to one sub-agency, or to match a different registry's single-agency
default (Eurostat/ECB/BIS/ILOSTAT/ABS, each already its own one agency).

**Not included: Stats NZ.** Its SDMX endpoint requires a platform API key
(`Ocp-Apim-Subscription-Key`, injected by the gateway from
`PLATFORM_STATSNZ_KEY`) and a literal, non-URL-encoded comma in its flowRef
path segment — neither fits this pack's keyless, URL-encoded-path design, and
the `stats-nz` pack already ships a dedicated structure tool. See that pack.

**Overlap with existing packs — read before calling this for ILO or ABS.**
The `ilostat` pack already ships `dataflow_structure` for ILO dataflows, and
the `abs-au` pack already ships `dataflow_structure` for ABS dataflows — both
inline codes directly, the same job `sdmx_dataflow_structure` here does. This
pack supports `registry: "ilo"` and `registry: "abs"` only for the standalone
`sdmx_codelist` lookup (a codelist by id, no dataflow needed) that neither of
those packs exposes. **Prefer ilostat's / abs-au's own `dataflow_structure`
for an ILO or ABS dataflow** — every response from this pack for those two
registries repeats that in an `overlap` field.

## Auth

Keyless. No auth on any of the eight registries above.

## Data sources

- Eurostat SDMX 2.1 REST API — <https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1> —
  structure endpoints (`/dataflow`, `/datastructure`, `/codelist`) answer
  SDMX-ML XML only; every JSON Accept header and `format=SDMX-JSON` query
  param this pack tried either 406s or is silently ignored (confirmed live
  2026-10-08). The eurostat pack's own data endpoint
  (`/dissemination/statistics/1.0/data`) is a *different* API that does speak
  JSON-stat — the two are not interchangeable.
- OECD SDMX 2.1 REST API — <https://sdmx.oecd.org/public/rest>.
- European Central Bank Data Portal — <https://data-api.ecb.europa.eu/service> —
  structure endpoints are XML only, same split the ecb pack already documents
  for its own `/dataflow` call (fleet #1158): the DATA endpoints speak
  SDMX-JSON, the STRUCTURE endpoints (`/dataflow`, `/datastructure`,
  `/codelist`) do not.
- UN Statistics Division SDMX hub — <https://data.un.org/legacy/ws/rest> — the
  documented `https://data.un.org/ws/rest/...` path 302-redirects here; this
  pack calls the redirect target directly. It is a small, multi-agency hub
  (~15 dataflows observed) carrying UNSD's own flows (`DF_UNDATA_ENERGY`,
  `DF_UNDATA_COUNTRYDATA`) alongside mirrored IAEG-SDGs, UIS and World Bank
  flows under their own agency ids — pass `agency` if a dataflow you want
  belongs to one of those rather than `UNSD`.
- IMF SDMX 2.1 REST API — <https://api.imf.org/external/sdmx/2.1>. **IMF
  concept-level representation trap:** some IMF dimensions carry no
  `localRepresentation.enumeration` at all — e.g. `EER`'s `COUNTRY` and
  `INDICATOR` dimensions. Their codelist is declared on the shared CONCEPT
  instead: the dimension's `conceptIdentity` URN points at a concept scheme
  (e.g. `IMF:CS_MASTER_DATA`), and that concept's own
  `coreRepresentation.enumeration` is the real codelist (`IMF:CL_COUNTRY` for
  `COUNTRY`). This pack follows that chain automatically; a naive
  implementation that only reads `dimension.localRepresentation` will report
  those dimensions as codeless.
- Bank for International Settlements SDMX 2.1 REST API —
  <https://stats.bis.org/api/v2/structure> (note the `/structure` segment —
  BIS nests dataflow/datastructure/codelist resources under it, unlike every
  other registry here).
- ILOSTAT SDMX 2.1 REST API — <https://sdmx.ilo.org/rest>. **Accept-Language
  trap:** ILO's backend returns a bare `500 languageTag1` body for any request
  with no `Accept-Language` header at all — reproduced with Node's/Workers'
  `fetch` (which sends none by default) but NOT with curl, confirmed live
  2026-10-08. This pack sends `Accept-Language: en` on every outbound request
  to every registry (harmless elsewhere) specifically because of this.
- Australian Bureau of Statistics Data API — <https://data.api.abs.gov.au/rest> —
  the documented host `api.data.abs.gov.au` does not resolve; this is the
  same live host the abs-au pack already found and documented.

**Size trap, all registries:** fetching a DSD with `references=children`
pulls in every codelist it uses in one response — Eurostat's `UNE_RT_M`
alone is 3.7MB because its `GEO` (country/region) codelist is 2.6MB. This pack
never does that: it fetches the DSD with `references=none` (a few KB — just
the dimension list and each dimension's codelist REFERENCE), then fetches
only the codelists actually needed, one at a time, each capped to
`max_codes_per_dimension` (default 50, max 500) with a truncation flag and the
true total code count.

**A 404 on a structure endpoint always means "no such id"** — unlike a data
endpoint, there is no "dataflow exists but no observations matched" ambiguity
for a structure query, so this pack does not need the data-endpoint
no_records/no_dataflow split that `shared/src/sdmx-miss.ts` provides for
other packs' `get_data` tools. Every 404 here comes back as a structured
`{error: "not_found", ...}` naming `sdmx_find_dataflow` as the next step. A
200 that parses to zero dimensions or zero dataflows is reported as a loud
`upstream_parse:` error, never as a silent empty result.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sdmx-structure": {
      "url": "https://gateway.pipeworx.io/sdmx-structure/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sdmx-structure/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sdmx_dataflow_structure \
  -H 'Content-Type: application/json' \
  -d '{"registry":"eurostat","dataflow":"une_rt_m"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sdmx_dataflow_structure`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-sdmx-structure` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/sdmx-structure/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "sdmx-structure": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sdmx-structure"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sdmx Structure data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
