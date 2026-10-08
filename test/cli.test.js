import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { main } from '../src/cli.js';

const BASE = 'https://api.test';
const PATH = '/api/public/v1/opportunities';
const BIG_ID = '1234567890123456789'; // 19 digits, past 2^53: must stay a string

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const row = (id, extra = {}) => ({
  id: String(id), type: 'federal', title: `Title ${id}`, agency: 'Dept of Testing', state: 'VA',
  response_deadline: '2026-11-01', url: `https://matchawards.com/x/posts/${id}`, ...extra,
});

const page = (ids, more = false, cursor = null) => json({ as_of: 'T0', results: ids.map((i) => row(i)), has_more: more, next_cursor: cursor });

/** Run the CLI with a mocked API. `handler(url, n)` answers the n-th request (1-based). */
async function run(argv, handler = () => page([]), columns) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, query: Object.fromEntries(u.searchParams), init });
    return handler(u, calls.length);
  };
  let out = '';
  let err = '';
  const code = await main(argv, {
    fetch,
    env: { MATCHAWARDS_API_BASE: `${BASE}/` },
    stdout: { columns, write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
  });
  return { code, out, err, calls };
}

// --- parameter mapping -----------------------------------------------------------------------------------------

test('search contracts maps every flag', async () => {
  const r = await run([
    'search', 'contracts', '--naics', ' 541511 , 541512', '--state', 'va', '-k', 'roof', '--set-aside', 'SBA',
    '--level', 'federal', '--days', '7', '--include-closed', '--limit', '5', '--cursor', 'abc', '--json',
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.calls[0].url.origin + r.calls[0].url.pathname, BASE + PATH);
  assert.deepEqual(r.calls[0].query, {
    type: 'federal', q: 'roof', naics: '541511,541512', state: 'VA', set_aside: 'SBA', posted_within_days: '7',
    open: 'false', limit: '5', cursor: 'abc',
  });
});

test('search contracts sends no unset param; open is absent without --include-closed', async () => {
  const r = await run(['search', 'contracts', '--set-aside', '', '--cursor', '']);
  assert.deepEqual(r.calls[0].query, { type: 'contract', limit: '20' });
});

test('search grants maps its flags and has no --state', async () => {
  const r = await run(['search', 'grants', '--naics', '541715', '--keyword', 'broadband', '--days', '180', '--include-closed', '--limit', '50']);
  assert.deepEqual(r.calls[0].query, {
    type: 'grant', q: 'broadband', naics: '541715', posted_within_days: '180', open: 'false', limit: '50',
  });
  const s = await run(['search', 'grants', '--state', 'VA']);
  assert.equal(s.code, 2);
  assert.match(s.err, /--state/);
});

test('search jobs defaults posted_within_days to 30 and has no --include-closed', async () => {
  const r = await run(['search', 'jobs', '--state', 'tx', '--keyword', 'electrician']);
  assert.deepEqual(r.calls[0].query, { type: 'job', q: 'electrician', state: 'TX', posted_within_days: '30', limit: '20' });
  const d = await run(['search', 'jobs', '--days', '7']);
  assert.equal(d.calls[0].query.posted_within_days, '7');
  const c = await run(['search', 'jobs', '--include-closed']);
  assert.equal(c.code, 2);
  assert.match(c.err, /--include-closed/);
});

test('naics maps codes, type (default contract) and cursor', async () => {
  const r = await run(['naics', '541511, 541512']);
  assert.deepEqual(r.calls[0].query, { type: 'contract', naics: '541511,541512', limit: '20' });
  const t = await run(['naics', '541511', '--type', 'grant', '--cursor', 'c1']);
  assert.deepEqual(t.calls[0].query, { type: 'grant', naics: '541511', cursor: 'c1', limit: '20' });
});

test('get returns the result row with as_of, without note', async () => {
  const r = await run(['get', BIG_ID, '--json'], () =>
    json({ as_of: 'T1', result: { ...row(BIG_ID), description: 'D', contacts: [{ name: 'Ann', title: 'CO' }] } }),
  );
  assert.equal(r.code, 0);
  assert.equal(r.calls[0].url.pathname, `${PATH}/${BIG_ID}`);
  assert.deepEqual(r.calls[0].query, {});
  const out = JSON.parse(r.out);
  assert.equal(out.as_of, 'T1');
  assert.equal(out.description, 'D');
  assert.equal(out.id, BIG_ID);
  assert.equal('note' in out, false);
});

test('get prints a readable record', async () => {
  const r = await run(['get', 'abc123'], () =>
    json({
      as_of: 'T1',
      result: {
        ...row('abc123'), office: 'Norfolk', naics: { code: '541511', title: 'Custom Computer Programming' },
        set_aside: 'SBA', city: 'Arlington', posted_at: '2026-10-01', sam_url: 'https://sam.gov/x',
        solicitation_number: 'S-1', description: 'Build it.', contacts: [],
      },
    }),
  );
  for (const s of ['Title:        Title abc123', 'Office:       Norfolk', 'NAICS:        541511 Custom Computer Programming',
    'Set-aside:    SBA', 'State/City:   VA / Arlington', 'Posted:       2026-10-01', 'Deadline:     2026-11-01',
    'URL:          https://matchawards.com/x/posts/abc123', 'SAM URL:      https://sam.gov/x', 'Solicitation: S-1',
    'Description:\nBuild it.', 'Contacts:\n  No contacts published.']) {
    assert.ok(r.out.includes(s), `missing ${JSON.stringify(s)} in\n${r.out}`);
  }
});

test('contacts returns {id, title, url, contacts} and prints name — title lines', async () => {
  const body = { as_of: 'T', result: { ...row('a1'), contacts: [{ name: 'Ann Lee', title: 'Contracting Officer' }, { name: 'Bo', title: null }] } };
  const j = await run(['contacts', 'a1', '--json'], () => json(body));
  assert.deepEqual(JSON.parse(j.out), {
    id: 'a1', title: 'Title a1', url: 'https://matchawards.com/x/posts/a1',
    contacts: [{ name: 'Ann Lee', title: 'Contracting Officer' }, { name: 'Bo', title: null }],
  });
  const t = await run(['contacts', 'a1'], () => json(body));
  assert.equal(t.out, 'Ann Lee — Contracting Officer\nBo\n');
  const none = await run(['contacts', 'a1'], () => json({ as_of: 'T', result: { ...row('a1'), contacts: null } }));
  assert.equal(none.out, 'No contacts published.\n');
  const noneJson = await run(['contacts', 'a1', '--json'], () => json({ as_of: 'T', result: { ...row('a1') } }));
  assert.deepEqual(JSON.parse(noneJson.out).contacts, []);
});

// --- validation ----------------------------------------------------------------------------------------------

test('validation failures exit 2, name the flag and make no request', async () => {
  const cases = [
    [['search', 'contracts', '--naics', '54151'], '--naics'],
    [['search', 'contracts', '--naics', Array(11).fill('541511').join(',')], '--naics'],
    [['search', 'contracts', '--naics', ''], '--naics'],
    [['search', 'contracts', '--state', 'Virginia'], '--state'],
    [['search', 'contracts', '--keyword', 'r'], '--keyword'],
    [['search', 'contracts', '-k', 'x'.repeat(101)], '--keyword'],
    [['search', 'contracts', '--level', 'county'], '--level'],
    [['search', 'contracts', '--days', '0'], '--days'],
    [['search', 'contracts', '--days', '181'], '--days'],
    [['search', 'contracts', '--days', '7.5'], '--days'],
    [['search', 'contracts', '--limit', '51'], '--limit'],
    [['search', 'contracts', '--limit', 'ten'], '--limit'],
    [['search', 'contracts', '--limit'], '--limit'],
    [['search', 'contracts', '--bogus'], '--bogus'],
    [['search', 'contracts', 'extra'], 'extra'],
    [['search', 'jobs', '--days', '31'], '--days'],
    [['naics'], '<codes>'],
    [['naics', '12345'], '<codes>'],
    [['naics', '541511', '--type', 'county'], '--type'],
    [['get'], '<id>'],
    [['get', 'a/b'], '<id>'],
    [['get', 'x'.repeat(129)], '<id>'],
    [['contacts', 'a b'], '<id>'],
    [['search', 'bids'], 'search bids'],
    [['frobnicate'], 'frobnicate'],
  ];
  for (const [argv, flag] of cases) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.ok(r.err.includes(flag), `${argv.join(' ')}: ${r.err}`);
    assert.equal(r.calls.length, 0, argv.join(' '));
  }
  const ok = await run(['search', 'contracts', '--keyword', 'ab', '--days', '180', '--limit', '1']);
  assert.equal(ok.code, 0);
});

// --- paging --------------------------------------------------------------------------------------------------

test('search follows the cursor for at most 3 pages, dedupes and asks only for what is missing', async () => {
  const pages = [page([1, 2], true, 'c2'), page([2, 3], true, 'c3'), page([4], true, 'c4'), page([5], true, 'c5')];
  const r = await run(['search', 'contracts', '--limit', '10', '--json'], (_u, n) => pages[n - 1]);
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.calls.map((c) => [c.query.limit, c.query.cursor]), [['10', undefined], ['8', 'c2'], ['7', 'c3']]);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.results.map((x) => x.id), ['1', '2', '3', '4']);
  assert.deepEqual([out.as_of, out.has_more, out.next_cursor], ['T0', true, 'c4']);
  assert.deepEqual(Object.keys(out), ['as_of', 'results', 'has_more', 'next_cursor']);
});

test('search stops once limit is reached or has_more is false', async () => {
  const full = await run(['search', 'grants', '--limit', '2', '--json'], () => page([1, 2], true, 'c2'));
  assert.equal(full.calls.length, 1);
  const last = await run(['search', 'grants', '--limit', '5', '--json'], () => page([1], false, null));
  assert.equal(last.calls.length, 1);
  assert.deepEqual(JSON.parse(last.out).next_cursor, null);
});

test('a failed follow-up page keeps the rows and adds a warning', async () => {
  const handler = (_u, n) => (n === 1 ? page([1, 2], true, 'c2') : json({ error: 'boom' }, 500));
  const r = await run(['search', 'contracts', '--limit', '5', '--json'], handler);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.results.map((x) => x.id), ['1', '2']);
  assert.equal(out.next_cursor, 'c2');
  assert.equal(
    out.warning,
    'Stopped after 2 rows: MatchAwards server error (HTTP 500). It is temporary; retry in a minute. ' +
      'More results may exist; call again with next_cursor.',
  );
  const t = await run(['search', 'contracts', '--limit', '5'], handler);
  assert.match(t.err, /^Warning: Stopped after 2 rows/);
  assert.match(t.out, /--cursor c2/);
});

test('a malformed follow-up page also becomes a warning; a malformed first page fails', async () => {
  const r = await run(['search', 'contracts', '--json'], (_u, n) => (n === 1 ? page([1], true, 'c2') : json({ results: 'no' })));
  assert.match(JSON.parse(r.out).warning, /results is not a list of objects/);
  const first = await run(['search', 'contracts'], () => json({ results: [1] }));
  assert.equal(first.code, 1);
  assert.match(first.err, /results is not a list of objects/);
});

// --- errors --------------------------------------------------------------------------------------------------

test('API errors map to the MCP wording and exit 1', async () => {
  const cases = [
    [json({ error: 'rate_limited' }, 429, { 'Retry-After': '12' }),
      'MatchAwards rate limit reached (per IP: 60 requests per minute, 20 per 5 seconds). Wait 12 seconds, then retry.'],
    [json({ error: 'rate_limited', retry_after: 7 }, 429), /Wait 7 seconds/],
    [json({}, 429), /Wait 60 seconds/],
    [json({ error: 'grants_unavailable' }, 503),
      'Grant search is temporarily unavailable on MatchAwards. Try again later; contracts and jobs still work.'],
    [new Response('oops', { status: 500 }), 'MatchAwards server error (HTTP 500). It is temporary; retry in a minute.'],
    [json({ error: 'invalid_parameter', message: 'bad naics', parameter: 'naics' }, 400),
      "MatchAwards rejected the parameter 'naics': bad naics. Fix it and call again."],
    [json({ error: 'not_found' }, 404), 'Not found on MatchAwards (not_found). Use an id from a search result.'],
    [new Response('forbidden here', { status: 403 }), 'MatchAwards rejected the request (HTTP 403): forbidden here'],
    [new Response('<html>', { status: 200 }), 'MatchAwards returned an unexpected response (HTTP 200, not a JSON object). Retry later.'],
    [json({ as_of: 'T' }), 'MatchAwards returned an unexpected API response (no result object).'],
  ];
  for (const [response, expected] of cases) {
    const r = await run(['get', 'abc'], () => response.clone());
    assert.equal(r.code, 1);
    if (expected instanceof RegExp) assert.match(r.err, expected);
    else assert.equal(r.err, expected + '\n');
    assert.equal(r.out, '');
  }
});

test('timeout and network failures use the MCP wording', async () => {
  const timeout = await run(['search', 'jobs'], () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.equal(timeout.code, 1);
  assert.equal(
    timeout.err,
    'MatchAwards did not answer within 10 seconds. Retry once; if it fails again, narrow the search ' +
      '(fewer NAICS codes, a shorter posted_within_days) or try later.\n',
  );
  assert.ok(timeout.calls[0].init.signal instanceof AbortSignal);
  const down = await run(['search', 'jobs'], () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  });
  assert.equal(down.err, `Could not reach MatchAwards at ${BASE} (ECONNREFUSED). Check the network and retry later.\n`);
});

// --- ids, headers, output ------------------------------------------------------------------------------------

test('a 19-digit id round-trips unchanged as a string', async () => {
  const raw = `{"as_of":"T","results":[{"id":"${BIG_ID}","title":"t","url":"u"}],"has_more":false,"next_cursor":null}`;
  const r = await run(['search', 'contracts', '--json'], () => new Response(raw, { status: 200 }));
  const out = JSON.parse(r.out);
  assert.equal(typeof out.results[0].id, 'string');
  assert.equal(out.results[0].id, BIG_ID);
  assert.ok(r.out.includes(`"id": "${BIG_ID}"`));
  assert.notEqual(String(Number(BIG_ID)), BIG_ID); // the reason ids are never numbers
});

test('User-Agent is matchawards-cli/<package.json version>', async () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const r = await run(['search', 'contracts']);
  const headers = r.calls[0].init.headers;
  assert.equal(headers['User-Agent'], `matchawards-cli/${version} (+https://github.com/matchawards/matchawards-cli)`);
  assert.ok(headers['User-Agent'].startsWith('matchawards-cli/'));
  assert.equal(headers.Accept, 'application/json');
});

test('table output shows the full url and a cursor hint with the same filters', async () => {
  const longUrl = `https://matchawards.com/${'a'.repeat(120)}/posts/1`;
  const r = await run(
    ['search', 'contracts', '--keyword', "roof repair's", '--state', 'VA', '--cursor', 'old'],
    () => json({ as_of: 'T', results: [row(1, { title: 'T'.repeat(100), url: longUrl })], has_more: true, next_cursor: 'NEXT=' }),
    80,
  );
  assert.equal(r.code, 0);
  const lines = r.out.trimEnd().split('\n');
  assert.match(lines[0], /^TITLE\s+AGENCY\s+STATE\s+DEADLINE\s+URL$/);
  assert.ok(lines[1].endsWith(longUrl));
  assert.ok(lines[1].includes('T'.repeat(19) + '…'));
  assert.equal(lines[2], `More results: matchawards search contracts --keyword 'roof repair'\\''s' --state VA --cursor NEXT=`);
});

test('no results and no cursor hint when has_more is false', async () => {
  const r = await run(['naics', '541511']);
  assert.equal(r.out, 'No results.\n');
});

test('help and version', async () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal((await run(['--version'])).out, `${version}\n`);
  for (const argv of [[], ['--help'], ['-h']]) assert.match((await run(argv)).out, /matchawards search contracts/);
  assert.match((await run(['search', '--help'])).out, /search grants/);
  for (const [argv, text] of [
    [['search', 'contracts', '--help'], /Search US federal and state government contract opportunities/],
    [['search', 'grants', '-h'], /grant and funding opportunities/],
    [['search', 'jobs', '--help'], /1 to 30 \(default 30\)/],
    [['naics', '--help'], /newest opportunities/],
    [['get', '-h'], /full record of one opportunity/],
    [['contacts', '--help'], /points of contact/],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 0);
    assert.match(r.out, text);
    assert.equal(r.calls.length, 0);
  }
});
