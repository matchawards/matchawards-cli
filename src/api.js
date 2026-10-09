// Read-only client of the public MatchAwards API. Behaviour and error wording mirror matchawards-mcp's server.py.
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const USER_AGENT = `matchawards-cli/${VERSION} (+https://github.com/matchawards/matchawards-cli)`;
export const TIMEOUT_S = 10; // the API answers within about 2 s by design
export const SEARCH_PATH = '/api/public/v1/opportunities';
export const MAX_PAGES = 3; // API requests one search may make while filling `limit`

/** A failure the user can act on; the message is printed as is. */
export class ApiError extends Error {}

export const apiBase = (env = process.env) =>
  (env.MATCHAWARDS_API_BASE || 'https://matchawards.com').replace(/\/+$/, '');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Turn an API error response ({error, parameter?} JSON) into advice the user can act on. */
export function errorMessage(r, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  body = isObject(body) ? body : {};
  const error = body.message || body.error || text.trim().slice(0, 200) || r.statusText;
  if (r.status === 429) {
    const wait = r.headers.get('Retry-After') || body.retry_after || 60;
    return (
      'MatchAwards rate limit reached (per IP: 60 requests per minute, 20 per 5 seconds). ' +
      `Wait ${wait} seconds, then retry.`
    );
  }
  if (body.error === 'grants_unavailable') {
    return 'Grant search is temporarily unavailable on MatchAwards. Try again later; contracts and jobs still work.';
  }
  if (r.status >= 500) return `MatchAwards server error (HTTP ${r.status}). It is temporary; retry in a minute.`;
  if (r.status === 400 && body.parameter) {
    return `MatchAwards rejected the parameter '${body.parameter}': ${error}. Fix it and call again.`;
  }
  if (r.status === 404) return `Not found on MatchAwards (${error}). Use an id from a search result.`;
  return `MatchAwards rejected the request (HTTP ${r.status}): ${error}`;
}

/** GET one API path; every failure becomes an ApiError. opts: {fetch, base}. */
export async function get(path, params = {}, { fetch = globalThis.fetch, base = apiBase() } = {}) {
  let url;
  try {
    url = new URL(base + path);
  } catch {
    throw new ApiError(`MATCHAWARDS_API_BASE is not a valid URL (${base}). Unset it to use https://matchawards.com.`);
  }
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); // "" = unset
  }
  let r, text;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_S * 1000),
    });
    text = await r.text();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new ApiError(
        `MatchAwards did not answer within ${TIMEOUT_S} seconds. Retry once; if it fails again, ` +
          'narrow the search (fewer NAICS codes, a shorter posted_within_days) or try later.',
      );
    }
    throw new ApiError(
      `Could not reach MatchAwards at ${base} (${e?.cause?.code || e?.name || 'Error'}). ` +
        'Check the network and retry later.',
    );
  }
  if (r.status >= 400) throw new ApiError(errorMessage(r, text));
  let data;
  try {
    data = JSON.parse(text); // ids are JSON strings, so no precision is lost
  } catch {
    data = null;
  }
  if (!isObject(data)) {
    throw new ApiError(
      `MatchAwards returned an unexpected response (HTTP ${r.status}, not a JSON object). Retry later.`,
    );
  }
  return data;
}

/** One opportunity: the API answers {as_of, result: {row..., description, contacts}}; return the row with as_of. */
export async function getOne(id, opts) {
  const data = await get(`${SEARCH_PATH}/${id}`, {}, opts);
  if (!isObject(data.result)) throw new ApiError('MatchAwards returned an unexpected API response (no result object).');
  return { ...data.result, as_of: data.as_of ?? null };
}

/** Collect up to `limit` unique rows, following next_cursor with the same filters for at most MAX_PAGES requests. */
export async function search(type, { limit = 20, keyword, ...filters } = {}, opts) {
  if (filters.naics) filters.naics = filters.naics.split(',').map((c) => c.trim()).join(',');
  if (filters.state) filters.state = filters.state.toUpperCase();
  const params = { type, q: keyword, ...filters };
  const rows = new Map();
  let page = null;
  let asOf = null;
  let warning = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    let next;
    try {
      // Ask only for what is still missing, so no row is read past the cursor and then dropped.
      next = await get(SEARCH_PATH, { ...params, limit: limit - rows.size }, opts);
      if (!Array.isArray(next.results) || !next.results.every(isObject)) {
        throw new ApiError('MatchAwards returned an unexpected API response (results is not a list of objects).');
      }
    } catch (e) {
      if (!(e instanceof ApiError) || page === null) throw e; // first page: nothing to return
      // Follow-up page: keep what we have; the last good page's next_cursor still points at the rest.
      warning = `Stopped after ${rows.size} rows: ${e.message} More results may exist; call again with next_cursor.`;
      break;
    }
    page = next;
    asOf = asOf || page.as_of || null;
    for (const row of page.results) if (!rows.has(row.id)) rows.set(row.id, row);
    if (rows.size >= limit || !(page.has_more && page.next_cursor)) break;
    params.cursor = page.next_cursor;
  }
  const out = {
    as_of: asOf,
    results: [...rows.values()],
    has_more: Boolean(page.has_more),
    next_cursor: page.next_cursor ?? null,
  };
  return warning ? { ...out, warning } : out;
}
