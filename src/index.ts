interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * What an SDMX REST server means by a 404 (fleet #2494).
 *
 * SDMX servers answer "nothing here" with a 404 and a one-line body, and the
 * same status covers two opposite situations:
 *   - the dataflow EXISTS and the key/period matched no observations — an
 *     honest empty, which must come back as an empty result with a reason
 *     (docs/silent-zero-policy.md), not as a failure; and
 *   - the dataflow id does NOT exist — the caller's argument is wrong, and the
 *     answer is a `not_found` pointing at the pack's list tool.
 * A 422 is a third caller mistake: the key has the wrong number of positions.
 *
 * Every SDMX pack used to throw all of these as a bare `<SOURCE>: 404 <body>`,
 * which the gateway books as class `error` (a Pipeworx defect, 500) and answers
 * with "Retry the same tool…". abs-au's one external caller retried 55 times in
 * an hour; istat-it, statec-lu and ilostat had the identical mapping.
 *
 * The body patterns are VERBATIM from the live servers, 2026-09-28. The wording
 * is per server implementation, not per agency, which is why it lives here once:
 *   .Stat Suite / NSI (ABS, ISTAT, STATEC, ILO):
 *     404 "NoRecordsFound"
 *     404 "Could not find Dataflow and/or DSD related with this data request"
 *     404 "Could not find requested structures"
 *     422 "Not enough key values in query, expecting 5 got 2"
 *     403 (OECD) "Not enough key values in query, expecting 13 got 10"
 *   ILO (its own no-data wording on the same NSI stack):
 *     404 "No data is found. Please adjust your query parameters and try again."
 *   Fusion Metadata Registry (UNICEF):
 *     404 {"errors":[{"code":404,"message":"No data for data query against the dataflow: urn:…"}]}
 *     404 {"errors":[{"code":404,"message":"No Dataflow exists for query : Target: Dataflow - … Maintainable Id: X …"}]}
 *
 * An unrecognised 404 body returns undefined on purpose: the pack keeps its old
 * error path, so a dead endpoint that also answers 404 stays visible as a
 * failure instead of being relabelled as a quiet empty.
 *
 * Self-contained (no imports) so publish-pack's helper inliner can copy it into
 * a standalone pack bundle.
 */

type SdmxMiss = 'no_records' | 'no_dataflow' | 'bad_key';

const NO_RECORDS = /NoRecordsFound|NoResultsFound|No data is found|No data for data query|No Results Found/i;
const NO_DATAFLOW = /Could not find Dataflow|Could not find requested structures?|No Dataflow exists|No Structures? (?:found|exists)/i;
const BAD_KEY = /key values in query|expecting \d+ got \d+|Invalid (?:data )?key|not a valid key/i;

/** Which caller-side miss an SDMX error response is, or undefined when it is none of them. */
function classifySdmxMiss(status: number, body: string): SdmxMiss | undefined {
  if (status === 404) {
    // Order matters only for a body that somehow names both; "no records"
    // presupposes the dataflow resolved, so it is the more specific claim.
    if (NO_RECORDS.test(body)) return 'no_records';
    if (NO_DATAFLOW.test(body)) return 'no_dataflow';
    return undefined;
  }
  if (status === 422) return 'bad_key';
  // OECD's .Stat Suite answers the same wrong-length key with a 403, not a 422
  // (live 2026-09-28, fleet #2496). Body-gated, so an auth 403 stays unclassified.
  if ((status === 400 || status === 403) && BAD_KEY.test(body)) return 'bad_key';
  return undefined;
}

/** A non-OK SDMX response, keeping status and body so a caller can classify it. */
class SdmxHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'SdmxHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The error a pack's SDMX fetch should throw for a non-OK response: carries
 * status and body, and leads with `upstream_down:` for a 5xx or 429 so a real
 * outage keeps its class.
 */
function sdmxHttpError(source: string, status: number, body: string): SdmxHttpError {
  const prefix = status >= 500 || status === 429 ? 'upstream_down: ' : '';
  return new SdmxHttpError(status, body, `${prefix}${source}: ${status} ${body}`);
}

interface SdmxMissContext {
  /** Human name of the source, e.g. "ISTAT". */
  source: string;
  dataflowId: string;
  key?: string;
  startPeriod?: string;
  endPeriod?: string;
  /** The pack's argument NAME for the dataflow id (default "dataflow_id"). */
  idArg?: string;
  /** The pack's list and structure tool names (defaults: list_dataflows, dataflow_structure). */
  listTool?: string;
  structureTool?: string;
  /**
   * Which endpoint answered. On a STRUCTURE query (/dataflow/…, /datastructure/…)
   * there are no observations to be missing, so a "no results" body can only
   * mean the structure does not exist — UNICEF answers an unknown dataflow's
   * structure with `{"errors":[{"code":404,"message":"No Results Found"}]}`.
   * Default 'data'.
   */
  endpoint?: 'data' | 'structure';
}

/**
 * The DSD id a dataflow points at, read from a `/dataflow/{agency}/{id}` stub
 * response (SDMX-JSON 1.0 `data.dataflows[0].structure`, a URN like
 * "urn:sdmx:…DataStructure=IT1:DCSP_COLTIVAZIONI(1.1)").
 *
 * Exists because a dataflow id is NOT its DSD id for every flow: ISTAT's
 * 101_1015 is DSD DCSP_COLTIVAZIONI, and 9 of ABS's 1,227 flows differ
 * (LF_UNDER → DS_LF_UNDER). A pack that asks /datastructure/{dataflowId} gets
 * "Could not find requested structures" for those, which must not be reported
 * as "no such dataflow".
 */
function dsdIdFromDataflow(json: unknown): string | undefined {
  const data = (json as { data?: { dataflows?: { structure?: unknown }[] } } | null)?.data;
  const urn = data?.dataflows?.[0]?.structure;
  if (typeof urn !== 'string') return undefined;
  const m = urn.match(/[=:]([A-Za-z0-9_@$\-]+)\([^)]*\)\s*$/);
  return m?.[1];
}

/**
 * What a pack should RETURN for a caught SDMX error, or undefined when the
 * error is not a recognised caller-side miss (the pack rethrows it).
 *
 *   no_records  → `{dataflow_id, key, series_count: 0, series: [], empty_reason: 'no_match', note}`
 *   no_dataflow → `{error: 'not_found', message}` naming the list tool
 *   bad_key     → `{error: 'user_error', message}` naming the structure tool
 *
 * Returned rather than thrown so the gateway books the envelope's own class
 * (user_error / not_found) with a 200, not a blanket thrown-exception 500.
 */
function sdmxMissResult(err: unknown, ctx: SdmxMissContext): Record<string, unknown> | undefined {
  if (!(err instanceof SdmxHttpError)) return undefined;
  let miss = classifySdmxMiss(err.status, err.body);
  if (!miss) return undefined;
  if (ctx.endpoint === 'structure' && miss === 'no_records') miss = 'no_dataflow';
  const idArg = ctx.idArg ?? 'dataflow_id';
  const listTool = ctx.listTool ?? 'list_dataflows';
  const structureTool = ctx.structureTool ?? 'dataflow_structure';
  const structureCall = `${structureTool}({${idArg}: "${ctx.dataflowId}"})`;
  if (miss === 'no_records') {
    const period = ctx.startPeriod || ctx.endPeriod ? ` in period ${ctx.startPeriod ?? '…'} to ${ctx.endPeriod ?? '…'}` : '';
    return {
      dataflow_id: ctx.dataflowId,
      key: ctx.key ?? 'all',
      ...(ctx.startPeriod ? { start_period: ctx.startPeriod } : {}),
      ...(ctx.endPeriod ? { end_period: ctx.endPeriod } : {}),
      series_count: 0,
      series: [],
      empty_reason: 'no_match',
      note:
        `${ctx.source} has dataflow "${ctx.dataflowId}" but no observations match key "${ctx.key ?? 'all'}"${period}. ` +
        `Check each dot-separated position against the valid codes from ${structureCall}, or widen the period.`,
    };
  }
  if (miss === 'no_dataflow') {
    return {
      error: 'not_found',
      message: `${ctx.source} has no dataflow "${ctx.dataflowId}". Call ${listTool} to find the id, then ${structureTool} to build the key.`,
      [idArg]: ctx.dataflowId,
    };
  }
  const detail = err.body.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    error: 'user_error',
    message:
      `${ctx.source} rejected key "${ctx.key ?? ''}" for dataflow "${ctx.dataflowId}"${detail ? `: ${detail}` : ''}. ` +
      `The key needs one dot-separated position per dimension, in the order ${structureCall} lists them.`,
  };
}
/**
 * SDMX Structure MCP — dataflow dimensions and code lists for any SDMX 2.1
 * registry: Eurostat, OECD, the ECB, the UN Statistics Division (via the
 * data.un.org SDMX hub), the IMF, and the Bank for International Settlements.
 *
 * This is the STRUCTURE half of SDMX — "what do the codes in this dataflow
 * mean" — which is distinct from pulling observations. Every SDMX 2.1
 * registry answers it at the same two logical endpoints:
 *   /dataflow/{agency}/{id}/{version}       -> which DSD (Data Structure
 *                                              Definition) the dataflow uses
 *   /datastructure/{agency}/{id}/{version}  -> the DSD's ordered dimensions,
 *                                              each pointing at a codelist
 *   /codelist/{agency}/{id}/{version}       -> the codelist's code->label pairs
 * but registries differ in base URL, default agency, and — the one that
 * actually breaks a naive implementation — whether the structure endpoints
 * answer JSON or XML:
 *   - Eurostat and the ECB answer STRUCTURE queries in SDMX-ML XML ONLY.
 *     Every Accept/format combination this pack tried (structure+json,
 *     bare application/json, format=SDMX-JSON query param) either 406s or
 *     is silently ignored — confirmed live 2026-10-08. The ECB pack already
 *     documented the same split for its own /dataflow endpoint (fleet #1158).
 *   - OECD, the IMF, BIS, and the UN data hub answer SDMX-JSON (2.0.0-ish
 *     shape: dataStructures[].dataStructureComponents.dimensionList, with
 *     localRepresentation.enumeration as a Codelist URN string per dimension).
 *
 * DSD id != dataflow id for many flows (Eurostat: UNE_RT_M dataflow v1.0 ->
 * DSD UNE_RT_M v155.0, same id different version; BIS: WS_CBPOL dataflow ->
 * DSD BIS_CBPOL, different id entirely) — this pack always resolves the DSD
 * reference from the dataflow response rather than assuming dataflow id ==
 * DSD id (the same trap ilostat's README calls out for ISTAT).
 *
 * IMF TRAP: some IMF dimensions carry no `localRepresentation.enumeration`
 * at all — their codelist is declared on the shared CONCEPT, not on the
 * dimension. The dimension's `conceptIdentity` URN points at a concept in a
 * concept scheme; that concept's `coreRepresentation.enumeration` is the
 * real codelist. This pack follows that chain when the direct path is empty
 * (resolveDimensionCodelist below) rather than reporting those dimensions
 * as codeless.
 *
 * SIZE TRAP: fetching a DSD with `references=children` pulls in EVERY
 * codelist the DSD uses in one response — for Eurostat's UNE_RT_M that is
 * 3.7MB because GEO (country/region codes) alone is 2.6MB. This pack never
 * does that: it fetches the DSD with `references=none` (a few KB — just the
 * dimension list and each one's codelist REFERENCE), then fetches only the
 * codelists actually needed, one at a time, each capped to
 * `max_codes_per_dimension` codes (default 50, max 500) with a truncation
 * flag and the true total count.
 *
 * DUPLICATION NOTE: the ilostat pack already ships `dataflow_structure` for
 * ILO, the stats-nz pack already ships a structure tool for Stats NZ, and
 * the abs-au pack already ships `dataflow_structure` for ABS — all three
 * inline codes directly for their one registry. This pack does not
 * re-implement those tools; `registry: "ilo"` and `registry: "abs"` are
 * supported here ONLY because this pack's value for those two is the
 * standalone `sdmx_codelist` lookup (a codelist by id, with no dataflow in
 * hand) that neither pack exposes — prefer ilostat/abs-au's own
 * `dataflow_structure` for an ILO or ABS dataflow. Stats NZ is excluded
 * entirely: it requires a platform API key (Ocp-Apim-Subscription-Key),
 * which does not fit this pack's keyless design, and stats-nz's own
 * structure tool already covers it.
 *
 * Keyless. No auth on any of the six registries below.
 */


const UA = 'pipeworx-mcp-sdmx-structure/1.0 (+https://pipeworx.io)';

// ILO TRAP: its .NET backend 500s with a bare body "languageTag1" whenever a
// request carries no Accept-Language header at all — reproduced with Node's
// fetch (undici sends none by default) but NOT with curl, confirmed live
// 2026-10-08. Every registry is happy to get one, so it is sent on every
// request rather than special-cased to one registry.
async function pwFetch(url: string | URL, sourceName: string, accept: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { Accept: accept, 'Accept-Language': 'en', 'User-Agent': UA } }, sourceName);
}

// ── Registry table ──────────────────────────────────────────────────────

interface RegistryConfig {
  id: string;
  name: string;
  base: string;
  agency: string;
  format: 'json' | 'xml';
  accept: string;
  docs: string;
  overlap?: string;
}

const REGISTRIES: Record<string, RegistryConfig> = {
  eurostat: {
    id: 'eurostat',
    name: 'Eurostat',
    base: 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1',
    agency: 'ESTAT',
    format: 'xml',
    accept: 'application/xml',
    docs: 'https://ec.europa.eu/eurostat/web/main/data/web-services',
  },
  oecd: {
    id: 'oecd',
    name: 'OECD',
    base: 'https://sdmx.oecd.org/public/rest',
    // "OECD" is NOT a maintaining agency that exists in this registry — every
    // dataflow is published under a DIRECTORATE sub-agency (OECD.SDD.NAD,
    // OECD.ELS.JAI, OECD.EDU.IMEP, ...; 52 distinct agencyIDs observed live,
    // including ESTAT and IAEG-SDGs mirrored in). A bare "OECD" 404s with
    // "No Results Found" on both the listing and single-dataflow paths —
    // confirmed live 2026-10-09, fleet #2839 follow-up. "all" resolves BOTH
    // shapes identically to the real sub-agency (verified side by side for
    // DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD via OECD.SDD.NAD vs "all" —
    // byte-identical dataflow entry back), so it is the default rather than
    // guessing a directorate.
    agency: 'all',
    format: 'json',
    accept: 'application/vnd.sdmx.structure+json',
    docs: 'https://data-explorer.oecd.org',
  },
  ecb: {
    id: 'ecb',
    name: 'European Central Bank',
    base: 'https://data-api.ecb.europa.eu/service',
    agency: 'ECB',
    format: 'xml',
    accept: 'application/xml',
    docs: 'https://data.ecb.europa.eu/help/api/overview',
  },
  unsd: {
    id: 'unsd',
    name: 'UN Statistics Division (data.un.org SDMX hub)',
    base: 'https://data.un.org/legacy/ws/rest',
    // "UNSD" alone 200s but returns only UNSD's OWN flows (1,414 bytes,
    // ~4 dataflows) — the hub also mirrors ESTAT, IAEG-SDGs, UIS and World
    // Bank dataflows under THEIR agency ids (confirmed live 2026-10-09: "all"
    // returns 4,428 bytes, ~15 dataflows, and a non-UNSD flow like ESTAT's
    // DF_SEEA_AEA resolves fine with agency "all" but 404s under "UNSD").
    // Default to "all" so find_dataflow/dataflow_structure see the whole hub.
    agency: 'all',
    format: 'json',
    accept: 'application/vnd.sdmx.structure+json',
    docs: 'https://data.un.org',
  },
  imf: {
    id: 'imf',
    name: 'IMF',
    base: 'https://api.imf.org/external/sdmx/2.1',
    // "IMF.STA" (Statistics Dept) 200s and used to look complete, but it is
    // one of TEN IMF sub-agencies (IMF.STA/MCD/SPR/AFR/MCM/FAD/WHD/APD/RES
    // plus the external ISORA) — confirmed live 2026-10-09: IMF.STA's own
    // catalogue has 190 dataflows, "all" has 223, and the 33 missing include
    // every regional economic outlook (APDREO, AFRREO, WHDREO...) and fiscal
    // affairs dataflows. "all" resolves a single dataflow lookup identically
    // to its real sub-agency too (APDREO via "all" vs IMF.APD: byte-identical).
    agency: 'all',
    format: 'json',
    accept: 'application/json',
    docs: 'https://data.imf.org',
  },
  bis: {
    id: 'bis',
    name: 'Bank for International Settlements',
    base: 'https://stats.bis.org/api/v2/structure',
    agency: 'BIS',
    format: 'json',
    accept: 'application/vnd.sdmx.structure+json',
    docs: 'https://stats.bis.org/api-doc/v2/',
  },
  ilo: {
    id: 'ilo',
    name: 'ILOSTAT',
    base: 'https://sdmx.ilo.org/rest',
    agency: 'ILO',
    format: 'json',
    accept: 'application/vnd.sdmx.structure+json',
    docs: 'https://ilostat.ilo.org',
    overlap: 'The ilostat pack already ships a dataflow_structure tool for ILO dataflows — prefer it for ILO. Use this pack for a standalone codelist lookup (sdmx_codelist) when you only have a codelist id.',
  },
  abs: {
    id: 'abs',
    name: 'Australian Bureau of Statistics',
    base: 'https://data.api.abs.gov.au/rest',
    agency: 'ABS',
    format: 'json',
    accept: 'application/vnd.sdmx.structure+json;version=1.0',
    docs: 'https://www.abs.gov.au/about/data-services/application-programming-interface-api',
    overlap: 'The abs-au pack already ships a dataflow_structure tool for ABS dataflows — prefer it for ABS. Use this pack for a standalone codelist lookup (sdmx_codelist) when you only have a codelist id.',
  },
};

const REGISTRY_IDS = Object.keys(REGISTRIES);

function registryOf(args: Record<string, unknown>): RegistryConfig {
  const id = String(args.registry ?? '').trim().toLowerCase();
  const reg = REGISTRIES[id];
  if (!reg) {
    throw new Error(
      `Unknown registry "${args.registry}". Supported: ${REGISTRY_IDS.join(', ')}.`,
    );
  }
  return reg;
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'sdmx_dataflow_structure',
    description:
      'Get the structure of one dataflow from any SDMX 2.1 registry: its ordered dimensions and, for each, the valid codes with labels. This answers "what do the codes in dataflow X mean" and "what key do I need to pull data from it" — use it before calling a registry-specific get_data tool. Covers eurostat, oecd, ecb, unsd (UN Statistics Division via the data.un.org SDMX hub), imf, bis, ilo, abs. For ILO or ABS dataflows, prefer the ilostat/abs-au packs\' own dataflow_structure tool — this one exists mainly for the other six. Example: sdmx_dataflow_structure({ registry: "eurostat", dataflow: "une_rt_m" }) or sdmx_dataflow_structure({ registry: "bis", dataflow: "WS_CBPOL" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        registry: {
          type: 'string',
          enum: REGISTRY_IDS,
          description: `Which SDMX registry to query: ${REGISTRY_IDS.join(', ')}.`,
        },
        dataflow: {
          type: 'string',
          description: 'Dataflow id, e.g. "une_rt_m" (Eurostat), "WS_CBPOL" (BIS), "EER" (IMF). Case usually does not matter but pass it exactly as published.',
        },
        agency: {
          type: 'string',
          description: 'Override the registry\'s default maintaining agency id, e.g. "OECD.SDD.NAD" for an OECD dataflow published by a specific directorate. Most callers can omit this.',
        },
        version: {
          type: 'string',
          description: 'Dataflow version, e.g. "1.0". Defaults to "latest".',
        },
        max_codes_per_dimension: {
          type: 'number',
          description: 'Cap codes returned per dimension (default 50, max 500). Codelists like country or region lists can have thousands of codes.',
        },
      },
      required: ['registry', 'dataflow'],
    },
  },
  {
    name: 'sdmx_codelist',
    description:
      'Fetch one codelist\'s code->label mapping by id, from any SDMX 2.1 registry, without needing a dataflow. Use this when you already know a codelist id (e.g. from sdmx_dataflow_structure\'s `codelist` field, or from a dataset\'s documentation) and just need the codes. Example: sdmx_codelist({ registry: "ilo", id: "CL_ECO" }) or sdmx_codelist({ registry: "eurostat", id: "GEO", filter: "France" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        registry: {
          type: 'string',
          enum: REGISTRY_IDS,
          description: `Which SDMX registry to query: ${REGISTRY_IDS.join(', ')}.`,
        },
        id: {
          type: 'string',
          description: 'Codelist id, e.g. "CL_ECO", "GEO", "CL_FREQ".',
        },
        agency: {
          type: 'string',
          description: 'Override the registry\'s default maintaining agency id for this codelist, e.g. "SDMX" for a shared CL_FREQ. Most callers can omit this.',
        },
        version: {
          type: 'string',
          description: 'Codelist version. Defaults to "latest".',
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive substring filter on code id or label, e.g. "france", "quarterly".',
        },
        limit: {
          type: 'number',
          description: 'Max codes to return (default 100, max 1000).',
        },
      },
      required: ['registry', 'id'],
    },
  },
  {
    name: 'sdmx_find_dataflow',
    description:
      'Keyword-search a registry\'s full dataflow catalogue by id or name substring. Use this to find the dataflow id to pass to sdmx_dataflow_structure when you only know a topic. Example: sdmx_find_dataflow({ registry: "bis", query: "credit" }) or sdmx_find_dataflow({ registry: "oecd", query: "unemployment" }). For Eurostat specifically, the eurostat pack\'s own search_datasets tool searches its ~10,000-entry table of contents with richer metadata (last-update dates, time coverage) and is usually the better choice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        registry: {
          type: 'string',
          enum: REGISTRY_IDS,
          description: `Which SDMX registry to query: ${REGISTRY_IDS.join(', ')}.`,
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring to match against dataflow id or name, e.g. "unemployment", "credit", "exchange rate".',
        },
        agency: {
          type: 'string',
          description: 'Restrict to one maintaining agency id instead of the registry default, e.g. "OECD.SDD.NAD".',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 50, max 300).',
        },
      },
      required: ['registry', 'query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'sdmx_dataflow_structure':
      return dataflowStructure(args);
    case 'sdmx_codelist':
      return codelistLookup(args);
    case 'sdmx_find_dataflow':
      return findDataflow(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Shared types ────────────────────────────────────────────────────────

interface ArtefactRef {
  agencyID: string;
  id: string;
  version: string;
}

interface DimensionInfo {
  id: string;
  position: number;
  isTime: boolean;
  enumRef?: ArtefactRef;
  conceptUrn?: string; // JSON registries only — fallback when enumRef is absent
}

interface NotFound {
  notFound: true;
  status: number;
  body: string;
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.max(min, Math.min(max, n));
}

/**
 * Default suggestion: point at sdmx_find_dataflow, the tool that resolves a
 * real id. NEVER pass this when the caller is already INSIDE
 * sdmx_find_dataflow (its own catalogue 404 — pass a different `suggestion`
 * there) — doing that told a caller to retry the exact call that just
 * failed, in a loop, until fleet #2839's follow-up caught it live against
 * OECD: `sdmx_find_dataflow({registry:"oecd", query:"unemployment"})` 404ed
 * on agency "OECD" and the not_found message sent the caller back to
 * `sdmx_find_dataflow({registry:"oecd", query:"..."})`.
 */
function findDataflowSuggestion(reg: RegistryConfig): string {
  return `Call sdmx_find_dataflow({registry:"${reg.id}", query:"..."}) to find a real id.`;
}

function notFoundResult(reg: RegistryConfig, kind: string, idArg: string, idVal: string, nf: NotFound, suggestion?: string) {
  return {
    error: 'not_found',
    message: `${reg.name} has no ${kind} "${idVal}" (HTTP ${nf.status}: ${nf.body.replace(/\s+/g, ' ').trim().slice(0, 200)}). ${suggestion ?? findDataflowSuggestion(reg)}`,
    registry: reg.id,
    [idArg]: idVal,
  };
}

// ── XML parsing (Eurostat, ECB) ────────────────────────────────────────
// Regex-based on purpose, matching the pattern already shipped in the ecb
// pack's parseDataflowXml — no DOMParser in the Workers runtime, and this
// codebase's established answer to that is a loose, namespace-agnostic
// regex rather than a dependency. One element matcher handles both the
// self-closing (`<Tag .../>`) and open/close (`<Tag ...>inner</Tag>`) forms
// in a single pass, which is what `Ref` (always self-closing) and
// `Dimension`/`Code`/`Codelist` (always open/close) both need.

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e] ?? e);
}

interface XmlElement {
  attrs: string;
  inner: string | undefined; // undefined for a self-closing tag
}

function matchElements(xml: string, tagName: string): XmlElement[] {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>)`, 'g');
  const out: XmlElement[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1], inner: m[2] });
  return out;
}

function xmlAttr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}

function xmlName(inner: string | undefined): string {
  if (!inner) return '';
  const en = /<(?:\w+:)?Name\b[^>]*xml:lang="en"[^>]*>([\s\S]*?)<\/(?:\w+:)?Name>/.exec(inner)?.[1];
  const any = en ?? /<(?:\w+:)?Name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Name>/.exec(inner)?.[1];
  return any ? decodeXmlEntities(any.trim()) : '';
}

/** First <Ref .../> inside an element's inner content, as an ArtefactRef. */
function xmlFirstRef(inner: string | undefined): ArtefactRef | undefined {
  if (!inner) return undefined;
  const refs = matchElements(inner, 'Ref');
  if (refs.length === 0) return undefined;
  const agencyID = xmlAttr(refs[0].attrs, 'agencyID');
  const id = xmlAttr(refs[0].attrs, 'id');
  const version = xmlAttr(refs[0].attrs, 'version');
  if (!agencyID || !id) return undefined;
  return { agencyID, id, version: version ?? 'latest' };
}

function parseDataflowXml(xml: string, dataflowId: string): { ref: ArtefactRef | undefined } {
  const flows = matchElements(xml, 'Dataflow');
  const match = flows.find((f) => (xmlAttr(f.attrs, 'id') ?? '').toLowerCase() === dataflowId.toLowerCase()) ?? flows[0];
  if (!match) return { ref: undefined };
  const structureEl = matchElements(match.inner ?? '', 'Structure')[0];
  return { ref: xmlFirstRef(structureEl?.inner) };
}

function parseDatastructureXml(xml: string): DimensionInfo[] {
  const dsdEl = matchElements(xml, 'DataStructure')[0];
  if (!dsdEl?.inner) return [];
  const dimListEl = matchElements(dsdEl.inner, 'DimensionList')[0];
  if (!dimListEl?.inner) return [];
  const dims: DimensionInfo[] = [];
  for (const el of matchElements(dimListEl.inner, 'Dimension')) {
    const localRep = matchElements(el.inner ?? '', 'LocalRepresentation')[0];
    const enumEl = localRep?.inner ? matchElements(localRep.inner, 'Enumeration')[0] : undefined;
    dims.push({
      id: xmlAttr(el.attrs, 'id') ?? '',
      position: Number(xmlAttr(el.attrs, 'position') ?? '0'),
      isTime: false,
      enumRef: xmlFirstRef(enumEl?.inner),
    });
  }
  for (const el of matchElements(dimListEl.inner, 'TimeDimension')) {
    dims.push({
      id: xmlAttr(el.attrs, 'id') ?? 'TIME_PERIOD',
      position: Number(xmlAttr(el.attrs, 'position') ?? '0'),
      isTime: true,
    });
  }
  return dims.filter((d) => d.id).sort((a, b) => a.position - b.position);
}

function parseCodelistXml(xml: string, cap: number): { agencyID?: string; total: number; codes: { id: string; name: string }[] } {
  const clEl = matchElements(xml, 'Codelist')[0];
  if (!clEl) return { total: 0, codes: [] };
  const agencyID = xmlAttr(clEl.attrs, 'agencyID');
  const codeEls = matchElements(clEl.inner ?? '', 'Code');
  const codes = codeEls.slice(0, cap).map((c) => ({ id: xmlAttr(c.attrs, 'id') ?? '', name: xmlName(c.inner) }));
  return { agencyID, total: codeEls.length, codes };
}

// ── JSON parsing (OECD, UNSD, IMF, BIS, ILO, ABS) ──────────────────────
// All five answer a 2.0.0-ish SDMX-JSON structure shape: data.dataflows[],
// data.dataStructures[], data.codelists[], data.conceptSchemes[] — verified
// live against every one of these registries 2026-10-08. Field names agree
// closely enough (dimensions[].localRepresentation.enumeration as a URN
// string; codelists[].codes[].name/.names.en) that one parser covers all
// five, mirroring the shape the ilostat pack already relies on for ILO.

interface JsonDim {
  id: string;
  position?: number;
  type?: string;
  localRepresentation?: { enumeration?: string };
  conceptIdentity?: string;
}

function parseUrnRef(urn: string | undefined, kind: string): ArtefactRef | undefined {
  if (typeof urn !== 'string') return undefined;
  const m = new RegExp(`${kind}=([^:]+):([^(]+)\\(([^)]+)\\)`).exec(urn);
  if (!m) return undefined;
  return { agencyID: m[1], id: m[2], version: m[3] };
}

function parseDataflowJson(json: unknown): { ref: ArtefactRef | undefined } {
  const flow = (json as { data?: { dataflows?: { structure?: string }[] } })?.data?.dataflows?.[0];
  return { ref: parseUrnRef(flow?.structure, 'DataStructure') };
}

function parseDatastructureJson(json: unknown): DimensionInfo[] {
  const ds = (json as { data?: { dataStructures?: { dataStructureComponents?: { dimensionList?: Record<string, unknown> } }[] } })
    ?.data?.dataStructures?.[0];
  const dl = ds?.dataStructureComponents?.dimensionList;
  if (!dl) return [];
  const regular = (dl.dimensions as JsonDim[] | undefined) ?? [];
  const timeRaw = dl.timeDimensions ?? dl.timeDimension;
  const time: JsonDim[] = Array.isArray(timeRaw) ? timeRaw : timeRaw ? [timeRaw as JsonDim] : [];
  const out: DimensionInfo[] = [];
  let autoPos = 0;
  for (const d of [...regular, ...time]) {
    out.push({
      id: d.id,
      position: typeof d.position === 'number' ? d.position : autoPos++,
      isTime: d.type === 'TimeDimension' || time.includes(d),
      enumRef: parseUrnRef(d.localRepresentation?.enumeration, 'Codelist'),
      conceptUrn: d.conceptIdentity,
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

function pickJsonName(o: { name?: string; names?: Record<string, string> } | undefined): string {
  if (!o) return '';
  return o.names?.en ?? o.name ?? '';
}

function parseCodelistJson(json: unknown, cap: number): { agencyID?: string; total: number; codes: { id: string; name: string }[] } {
  const cl = (json as { data?: { codelists?: { agencyID?: string; codes?: { id: string; name?: string; names?: Record<string, string> }[] }[] } })
    ?.data?.codelists?.[0];
  if (!cl) return { total: 0, codes: [] };
  const all = cl.codes ?? [];
  return {
    agencyID: cl.agencyID,
    total: all.length,
    codes: all.slice(0, cap).map((c) => ({ id: c.id, name: pickJsonName(c) })),
  };
}

/**
 * IMF TRAP (see file header): when a dimension has no direct
 * localRepresentation.enumeration, its codelist is declared on the shared
 * CONCEPT instead. conceptIdentity is a URN like
 * "urn:...Concept=IMF.STA:CS_EER(4.1.0).INDICATOR" — agency:scheme(version).conceptId.
 * Fetch that concept scheme (cached per call, since many dimensions across
 * a DSD often share one) and read the matching concept's
 * coreRepresentation.enumeration.
 */
async function resolveConceptCodelist(
  reg: RegistryConfig,
  conceptUrn: string,
  cache: Map<string, unknown>,
): Promise<ArtefactRef | undefined> {
  const m = /Concept=([^:]+):([^(]+)\(([^)]+)\)\.(.+)$/.exec(conceptUrn);
  if (!m) return undefined;
  const [, csAgency, csId, csVersion, conceptId] = m;
  const cacheKey = `${csAgency}:${csId}:${csVersion}`;
  let json = cache.get(cacheKey);
  if (json === undefined) {
    try {
      const url = `${reg.base}/conceptscheme/${encodeURIComponent(csAgency)}/${encodeURIComponent(csId)}/${encodeURIComponent(csVersion)}?references=none`;
      const res = await pwFetch(url, reg.name, reg.accept);
      json = res.ok ? JSON.parse(await readBodyText(res)) : null;
    } catch {
      json = null;
    }
    cache.set(cacheKey, json);
  }
  if (!json) return undefined;
  const concepts = (json as { data?: { conceptSchemes?: { concepts?: { id: string; coreRepresentation?: { enumeration?: string } }[] }[] } })
    ?.data?.conceptSchemes?.[0]?.concepts ?? [];
  const concept = concepts.find((c) => c.id === conceptId);
  return parseUrnRef(concept?.coreRepresentation?.enumeration, 'Codelist');
}

// ── Fetch helpers ───────────────────────────────────────────────────────

/**
 * EUROSTAT GZIP TRAP (confirmed live from an actual deployed Worker,
 * 2026-10-08, not just a laptop — see the pack-wide note in the file
 * header). Eurostat's structure endpoints sit behind Cloudflare themselves,
 * and a Worker-to-Cloudflare-origin fetch gets back a gzip-compressed body
 * with NO `Content-Encoding` header at all (`content-disposition` still
 * names it "....xml.gz", which is the tell) — so the runtime has no signal
 * to auto-decompress it, and `res.text()` on the raw bytes produces mojibake
 * that fails every downstream parse. The identical request from curl or
 * Node gets a plain, uncompressed body (verified side by side), so this is
 * invisible to a laptop smoke test and only shows up on real Worker egress
 * — the same class of trap `docs/reference_browser_verified_is_not_worker_reachable`
 * exists to catch. Detected by sniffing the gzip magic bytes (0x1f 0x8b)
 * rather than trusting Content-Encoding, and manually run through
 * DecompressionStream when present, for every registry (cheap no-op when
 * the bytes aren't gzip).
 */
async function readBodyText(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function fetchOrNotFound(url: string, reg: RegistryConfig): Promise<{ text: string } | NotFound> {
  const res = await pwFetch(url, reg.name, reg.accept);
  if (res.status === 404) {
    const body = await readBodyText(res).catch(() => '');
    return { notFound: true, status: 404, body };
  }
  if (!res.ok) {
    const body = await readBodyText(res).catch(() => '');
    throw sdmxHttpError(reg.name, res.status, body.slice(0, 300));
  }
  return { text: await readBodyText(res) };
}

function isNotFound(v: unknown): v is NotFound {
  return typeof v === 'object' && v !== null && (v as NotFound).notFound === true;
}

async function getDataflowRef(
  reg: RegistryConfig,
  agency: string,
  dataflowId: string,
  version: string,
): Promise<{ ref: ArtefactRef | undefined; url: string } | NotFound> {
  const url = `${reg.base}/dataflow/${encodeURIComponent(agency)}/${encodeURIComponent(dataflowId)}/${encodeURIComponent(version)}?references=none`;
  const fetched = await fetchOrNotFound(url, reg);
  if (isNotFound(fetched)) return fetched;
  const ref = reg.format === 'xml' ? parseDataflowXml(fetched.text, dataflowId).ref : parseDataflowJson(JSON.parse(fetched.text)).ref;
  return { ref, url };
}

async function getDimensions(reg: RegistryConfig, dsdRef: ArtefactRef): Promise<{ dims: DimensionInfo[]; url: string } | NotFound> {
  const url = `${reg.base}/datastructure/${encodeURIComponent(dsdRef.agencyID)}/${encodeURIComponent(dsdRef.id)}/${encodeURIComponent(dsdRef.version)}?references=none`;
  const fetched = await fetchOrNotFound(url, reg);
  if (isNotFound(fetched)) return fetched;
  const dims = reg.format === 'xml' ? parseDatastructureXml(fetched.text) : parseDatastructureJson(JSON.parse(fetched.text));
  return { dims, url };
}

async function getCodelist(
  reg: RegistryConfig,
  ref: ArtefactRef,
  cap: number,
): Promise<{ agencyID?: string; total: number; codes: { id: string; name: string }[]; url: string } | NotFound> {
  const url = `${reg.base}/codelist/${encodeURIComponent(ref.agencyID)}/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}`;
  const fetched = await fetchOrNotFound(url, reg);
  if (isNotFound(fetched)) return fetched;
  const parsed = reg.format === 'xml' ? parseCodelistXml(fetched.text, cap) : parseCodelistJson(JSON.parse(fetched.text), cap);
  return { ...parsed, url };
}

// ── Tool implementations ────────────────────────────────────────────────

async function dataflowStructure(args: Record<string, unknown>) {
  const reg = registryOf(args);
  const dataflowId = reqStr(args, 'dataflow', '"une_rt_m"');
  const agency = (args.agency as string | undefined)?.trim() || reg.agency;
  const version = (args.version as string | undefined)?.trim() || 'latest';
  const maxCodes = clampNum(args.max_codes_per_dimension, 50, 1, 500);

  const dfResult = await getDataflowRef(reg, agency, dataflowId, version);
  if (isNotFound(dfResult)) return notFoundResult(reg, 'dataflow', 'dataflow', dataflowId, dfResult);
  if (!dfResult.ref) {
    throw new Error(
      `upstream_parse: ${reg.name} answered the dataflow "${dataflowId}" lookup (${dfResult.url}) with a 200 that carried no DataStructure reference — the ${reg.format.toUpperCase()} shape this tool parses may have changed upstream.`,
    );
  }

  const dsdResult = await getDimensions(reg, dfResult.ref);
  if (isNotFound(dsdResult)) {
    return notFoundResult(reg, 'data structure', 'dataflow', dataflowId, dsdResult);
  }
  if (dsdResult.dims.length === 0) {
    throw new Error(
      `upstream_parse: ${reg.name}'s data structure for dataflow "${dataflowId}" (${dsdResult.url}) came back 200 with zero recognisable dimensions — the ${reg.format.toUpperCase()} shape this tool parses may have changed upstream.`,
    );
  }

  // Resolve each dimension's codelist reference, falling back to the
  // concept-level representation for JSON registries that omit it on the
  // dimension itself (the IMF trap — see file header).
  const conceptCache = new Map<string, unknown>();
  const resolved: (ArtefactRef | undefined)[] = [];
  for (const d of dsdResult.dims) {
    if (d.enumRef) {
      resolved.push(d.enumRef);
    } else if (reg.format === 'json' && d.conceptUrn) {
      resolved.push(await resolveConceptCodelist(reg, d.conceptUrn, conceptCache));
    } else {
      resolved.push(undefined);
    }
  }

  // Dedupe codelist fetches — several dimensions often share one (e.g.
  // ECB's CURRENCY and CURRENCY_DENOM both point at CL_CURRENCY).
  type CodelistEntry = { agencyID?: string; total: number; codes: { id: string; name: string }[]; url: string } | { error: string } | undefined;
  const uniqueRefs = new Map<string, ArtefactRef>();
  for (const r of resolved) if (r) uniqueRefs.set(`${r.agencyID}:${r.id}:${r.version}`, r);
  const clEntries: [string, CodelistEntry][] = await Promise.all(
    [...uniqueRefs.entries()].map(async ([key, ref]): Promise<[string, CodelistEntry]> => {
      try {
        const cl = await getCodelist(reg, ref, maxCodes);
        return [key, isNotFound(cl) ? undefined : cl];
      } catch (err) {
        return [key, { error: String(err instanceof Error ? err.message : err) }];
      }
    }),
  );
  const clMap = new Map<string, CodelistEntry>(clEntries);

  const dimensions = dsdResult.dims.map((d, i) => {
    const ref = resolved[i];
    const key = ref ? `${ref.agencyID}:${ref.id}:${ref.version}` : undefined;
    const cl = key ? clMap.get(key) : undefined;
    const codes = cl && 'codes' in cl ? cl.codes : [];
    const total = cl && 'total' in cl ? cl.total : 0;
    return {
      id: d.id,
      position: d.position,
      is_time: d.isTime,
      codelist: ref ? `${ref.agencyID}:${ref.id}` : null,
      code_count: total,
      codes,
      codes_truncated: total > codes.length,
      ...(cl && 'error' in cl ? { codelist_error: cl.error } : {}),
    };
  });

  return {
    registry: reg.id,
    registry_name: reg.name,
    dataflow: dataflowId,
    agency,
    dsd: `${dfResult.ref.agencyID}:${dfResult.ref.id}(${dfResult.ref.version})`,
    structure_url: dsdResult.url,
    dimension_order: dimensions.filter((d) => !d.is_time).map((d) => d.id),
    key_template: dimensions.filter((d) => !d.is_time).map(() => '').join('.'),
    dimensions,
    overlap: reg.overlap ?? null,
    note: 'Build a get_data key (registry-specific tool) by placing one code, or empty for wildcard, per non-time dimension in dimension_order, dot-separated.',
  };
}

async function codelistLookup(args: Record<string, unknown>) {
  const reg = registryOf(args);
  const id = reqStr(args, 'id', '"CL_FREQ"');
  const agency = (args.agency as string | undefined)?.trim() || reg.agency;
  const version = (args.version as string | undefined)?.trim() || 'latest';
  const limit = clampNum(args.limit, 100, 1, 1000);
  const filter = ((args.filter as string | undefined) ?? '').toLowerCase().trim();

  // Fetch with a generous cap so a filter can match beyond the first `limit`
  // raw codes, then filter and re-cap. 2000 keeps a CL_COUNTRY-sized list
  // (~350) comfortably inside one fetch while bounding a CL_GEO-sized one.
  const result = await getCodelist(reg, { agencyID: agency, id, version }, 2000);
  if (isNotFound(result)) return notFoundResult(reg, 'codelist', 'id', id, result);

  const matched = filter
    ? result.codes.filter((c) => c.id.toLowerCase().includes(filter) || c.name.toLowerCase().includes(filter))
    : result.codes;

  return {
    registry: reg.id,
    registry_name: reg.name,
    id,
    agency: result.agencyID ?? agency,
    codelist_url: result.url,
    total_codes: result.total,
    matched: matched.length,
    returned: Math.min(matched.length, limit),
    codes_truncated: result.total > result.codes.length,
    codes: matched.slice(0, limit),
    overlap: reg.overlap ?? null,
  };
}

async function findDataflow(args: Record<string, unknown>) {
  const reg = registryOf(args);
  const query = reqStr(args, 'query', '"unemployment"');
  const agency = (args.agency as string | undefined)?.trim() || reg.agency;
  const limit = clampNum(args.limit, 50, 1, 300);

  const url = `${reg.base}/dataflow/${encodeURIComponent(agency)}/all/latest?detail=allstubs`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: { Accept: reg.accept, 'Accept-Language': 'en', 'User-Agent': UA },
      // Edge-cache the full catalogue — identical for every caller of this
      // tool on this registry, and it is the one call here big enough
      // (hundreds of KB to several MB) to matter. Mirrors the eurostat
      // pack's own TOC caching.
      cf: { cacheTtlByStatus: { '200-299': 21600, '400-499': 60, '500-599': 10 }, cacheEverything: true },
    } as RequestInit,
    reg.name,
  );
  if (res.status === 404) {
    const body = await readBodyText(res).catch(() => '');
    // This IS sdmx_find_dataflow — the default "call sdmx_find_dataflow to
    // find a real id" suggestion would point the caller straight back at
    // the call that just failed. Suggest the escape hatches that actually
    // differ: a different agency, or the registry's own docs.
    return notFoundResult(
      reg,
      'dataflow catalogue',
      'agency',
      agency,
      { notFound: true, status: 404, body },
      `"${agency}" is not a maintaining agency ${reg.name} recognises. Try agency: "all" (the default for most registries here), or check ${reg.docs} for the real agency id.`,
    );
  }
  if (!res.ok) {
    const body = await readBodyText(res).catch(() => '');
    throw sdmxHttpError(reg.name, res.status, body.slice(0, 300));
  }
  const text = await readBodyText(res);
  const flows =
    reg.format === 'xml'
      ? matchElements(text, 'Dataflow').map((f) => ({ id: xmlAttr(f.attrs, 'id') ?? '', name: xmlName(f.inner) }))
      : ((JSON.parse(text) as { data?: { dataflows?: { id: string; name?: string; names?: Record<string, string> }[] } }).data?.dataflows ?? []).map(
          (f) => ({ id: f.id, name: pickJsonName(f) }),
        );
  if (flows.length === 0) {
    throw new Error(
      `upstream_parse: ${reg.name}'s dataflow catalogue for agency "${agency}" (${url}) came back 200 with zero recognisable dataflows — the ${reg.format.toUpperCase()} shape this tool parses may have changed upstream.`,
    );
  }
  const needle = query.toLowerCase();
  const matched = flows.filter((f) => f.id.toLowerCase().includes(needle) || (f.name ?? '').toLowerCase().includes(needle));
  return {
    registry: reg.id,
    registry_name: reg.name,
    agency,
    catalogue_url: url,
    total_dataflows: flows.length,
    matched: matched.length,
    returned: Math.min(matched.length, limit),
    dataflows: matched.slice(0, limit),
    note: matched.length === 0 ? 'No match. Try a broader single keyword, or a different agency (pass `agency`).' : undefined,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
