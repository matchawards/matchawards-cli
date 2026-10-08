// Command-line front end: argument parsing, validation (same limits as the MCP tools) and output.
import { parseArgs } from 'node:util';
import { ApiError, VERSION, apiBase, getOne, search } from './api.js';

/** A bad flag or argument: printed to stderr, exit 2. */
class UsageError extends Error {}

const bad = (flag, why) => {
  throw new UsageError(`${flag} ${why}`);
};

const NAICS_RE = /^\s*\d{6}(\s*,\s*\d{6}){0,9}\s*$/;
const NAICS_WHY = 'must be up to 10 six-digit NAICS codes, comma-separated, e.g. 541511,541512';

function int(flag, raw, min, max) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || +raw < min || +raw > max) bad(flag, `must be a whole number from ${min} to ${max}`);
  return +raw;
}

const oneOf = (flag, raw, allowed) => {
  if (raw !== undefined && !allowed.includes(raw)) bad(flag, `must be one of: ${allowed.join(', ')}`);
  return raw;
};

function oppId(raw) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(raw)) bad('<id>', 'must be the id field of a search result (letters, digits, _ or -)');
  return raw;
}

// Option definitions (parseArgs) and help lines, shared by the commands. Wording follows the MCP tool fields.
const OPTS = {
  naics: [{ type: 'string' }, '--naics CODES', 'Up to 10 six-digit NAICS codes, comma-separated, e.g. 541511,541512. Unknown codes are ignored.'],
  state: [{ type: 'string' }, '--state XX', 'Two-letter US state code, e.g. VA. Many federal notices have no state, so this filter skips them.'],
  keyword: [{ type: 'string', short: 'k' }, '-k, --keyword TEXT', '2 to 100 characters matched against the title only.'],
  'set-aside': [{ type: 'string' }, '--set-aside CODE', 'Set-aside code, e.g. SBA or SDVOSBC. Federal contracts only.'],
  level: [{ type: 'string' }, '--level LEVEL', 'federal or state: narrow to one level. Leave out for both.'],
  days: [{ type: 'string' }, '--days N', 'Only items posted in the last N days, 1 to 180 (default 180).'],
  'include-closed': [{ type: 'boolean' }, '--include-closed', 'Include closed items too. Default: only items with a response deadline of today or later, US Eastern; an item with no deadline counts as closed.'],
  limit: [{ type: 'string' }, '--limit N', 'Number of results to return, 1 to 50 (default 20).'],
  cursor: [{ type: 'string' }, '--cursor C', 'next_cursor from the previous response. Pass it with the same filters to get the next page.'],
  type: [{ type: 'string' }, '--type TYPE', 'contract (default) = federal and state contracts; federal or state = one level only; grant; job.'],
  json: [{ type: 'boolean' }, '--json', 'Print the result object as JSON (for scripts) instead of text.'],
  help: [{ type: 'boolean', short: 'h' }, '-h, --help', 'Show this help.'],
};

function keyword(raw) {
  if (raw !== undefined && ([...raw].length < 2 || [...raw].length > 100)) bad('--keyword', 'must be 2 to 100 characters');
  return raw;
}

function naics(raw, flag = '--naics') {
  if (raw !== undefined && !NAICS_RE.test(raw)) bad(flag, NAICS_WHY);
  return raw;
}

function state(raw) {
  if (raw !== undefined && !/^[A-Za-z]{2}$/.test(raw)) bad('--state', 'must be a two-letter US state code, e.g. VA');
  return raw;
}

const open = (v) => (v['include-closed'] ? false : undefined);
const limit = (v) => int('--limit', v.limit, 1, 50) ?? 20;

const COMMANDS = {
  'search contracts': {
    usage: 'matchawards search contracts [options]',
    about: 'Search US federal and state government contract opportunities (bids, RFPs, solicitations).',
    example: 'matchawards search contracts --naics 238160 --state VA --keyword roof',
    opts: ['naics', 'state', 'keyword', 'set-aside', 'level', 'days', 'include-closed', 'limit', 'cursor', 'json', 'help'],
    run: (v, _p, api) =>
      search(
        oneOf('--level', v.level, ['federal', 'state']) || 'contract',
        {
          naics: naics(v.naics), state: state(v.state), keyword: keyword(v.keyword), set_aside: v['set-aside'],
          posted_within_days: int('--days', v.days, 1, 180), open: open(v), limit: limit(v), cursor: v.cursor,
        },
        api,
      ),
  },
  'search grants': {
    usage: 'matchawards search grants [options]',
    about: 'Search US federal grant and funding opportunities. Grant notices carry no state, so there is no state filter.',
    example: 'matchawards search grants --keyword broadband',
    opts: ['naics', 'keyword', 'days', 'include-closed', 'limit', 'cursor', 'json', 'help'],
    run: (v, _p, api) =>
      search(
        'grant',
        {
          naics: naics(v.naics), keyword: keyword(v.keyword), posted_within_days: int('--days', v.days, 1, 180),
          open: open(v), limit: limit(v), cursor: v.cursor,
        },
        api,
      ),
  },
  'search jobs': {
    usage: 'matchawards search jobs [options]',
    about: 'Search job postings from the last 30 days listed on MatchAwards.',
    example: 'matchawards search jobs --keyword electrician --state TX --days 7',
    opts: ['naics', 'state', 'keyword', 'days', 'limit', 'cursor', 'json', 'help'],
    help: { days: 'Only jobs posted in the last N days, 1 to 30 (default 30).' },
    run: (v, _p, api) =>
      search(
        'job',
        {
          naics: naics(v.naics), state: state(v.state), keyword: keyword(v.keyword),
          posted_within_days: int('--days', v.days, 1, 30) ?? 30, limit: limit(v), cursor: v.cursor,
        },
        api,
      ),
  },
  naics: {
    usage: 'matchawards naics <codes> [options]',
    about:
      'List the newest opportunities (up to 20) for one or more NAICS industry codes. For keyword, state or ' +
      'other filters use `matchawards search`.',
    example: 'matchawards naics 541511,541512 --type federal',
    positional: '<codes>',
    opts: ['type', 'cursor', 'json', 'help'],
    run: (v, [codes], api) =>
      search(
        oneOf('--type', v.type, ['contract', 'federal', 'state', 'grant', 'job']) || 'contract',
        { naics: naics(codes, '<codes>'), cursor: v.cursor },
        api,
      ),
  },
  get: {
    usage: 'matchawards get <id> [--json]',
    about:
      'Get the full record of one opportunity by its id from a search result: the search row plus description ' +
      '(up to 2000 characters) and contacts.',
    example: 'matchawards get 117402307943537453',
    positional: '<id>',
    opts: ['json', 'help'],
    run: (_v, [id], api) => getOne(oppId(id), api),
  },
  contacts: {
    usage: 'matchawards contacts <id> [--json]',
    about:
      'Get only the published points of contact for one opportunity by its id, as the public matchawards.com ' +
      'page shows them.',
    example: 'matchawards contacts 117402307943537453',
    positional: '<id>',
    opts: ['json', 'help'],
    run: async (_v, [id], api) => {
      const data = await getOne(oppId(id), api);
      return { id: 'id' in data ? data.id : id, title: data.title ?? null, url: data.url ?? null, contacts: data.contacts || [] };
    },
  },
};

const MAIN_HELP = `matchawards ${VERSION}: search US government contract opportunities (federal and state), grants
and jobs from matchawards.com. Read-only, no account needed.

Usage:
  matchawards search contracts [options]   Federal and state contract opportunities
  matchawards search grants [options]      Federal grant and funding opportunities
  matchawards search jobs [options]        Job postings from the last 30 days
  matchawards naics <codes> [--type TYPE]  The newest opportunities for up to 10 NAICS codes
  matchawards get <id>                     The full record of one opportunity
  matchawards contacts <id>                Only the published points of contact for one opportunity

Every command takes --json (print the result object for scripts) and -h, --help.
  --version  Print the version.

Environment: MATCHAWARDS_API_BASE (default https://matchawards.com)
Run \`matchawards <command> --help\` for its options.
`;

const SEARCH_HELP = `Usage:
  matchawards search contracts [options]   Federal and state contract opportunities
  matchawards search grants [options]      Federal grant and funding opportunities
  matchawards search jobs [options]        Job postings from the last 30 days

Run \`matchawards search <contracts|grants|jobs> --help\` for its options.
`;

function commandHelp(cmd) {
  const lines = cmd.opts.map((k) => [OPTS[k][1], cmd.help?.[k] ?? OPTS[k][2]]);
  const w = Math.max(...lines.map(([f]) => f.length)) + 2;
  return (
    `Usage: ${cmd.usage}\n\n${cmd.about}\n\nOptions:\n` +
    lines.map(([f, d]) => `  ${f.padEnd(w)}${d}`).join('\n') +
    `\n\nExample: ${cmd.example}\n`
  );
}

// --- text output ---------------------------------------------------------------------------------------------

const fit = (s, w) => {
  s = String(s ?? '');
  return (s.length > w ? s.slice(0, w - 1) + '…' : s).padEnd(w);
};

/** Quote one argument for a POSIX shell, only when needed. */
const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** The same command line with --cursor replaced by `cursor` (and --json dropped). */
function nextCommand(words, args, cursor) {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cursor') i++;
    else if (!args[i].startsWith('--cursor=') && args[i] !== '--json') kept.push(args[i]);
  }
  return ['matchawards', ...words, ...kept, '--cursor', cursor].map(shq).join(' ');
}

function table(out, columns) {
  if (!out.results.length) return 'No results.\n';
  const rows = out.results.map((r) => [r.title, r.agency, r.state, r.response_deadline, r.url ?? '']);
  const heads = ['TITLE', 'AGENCY', 'STATE', 'DEADLINE'];
  const widest = (i) => Math.max(heads[i].length, ...rows.map((r) => String(r[i] ?? '').length));
  const widths = [Infinity, 28, 5, 10].map((cap, i) => Math.min(cap, widest(i)));
  const urlW = Math.max(...rows.map((r) => r[4].length));
  // On a terminal the title takes what is left after the other columns (at least 20); piped, up to 60.
  // The url is never cut.
  const room = columns ? columns - widths[1] - widths[2] - widths[3] - urlW - 8 : 60;
  widths[0] = Math.min(widths[0], Math.max(20, Math.min(60, room)));
  const line = (cells) => cells.slice(0, 4).map((c, i) => fit(c, widths[i])).join('  ') + '  ' + cells[4];
  return [line(['TITLE', 'AGENCY', 'STATE', 'DEADLINE', 'URL']), ...rows.map(line)].join('\n') + '\n';
}

function record(r) {
  const naicsText = r.naics && [r.naics.code, r.naics.title].filter(Boolean).join(' ');
  const where = [r.state, r.city].filter(Boolean).join(' / ');
  const fields = [
    ['Title', r.title], ['Type', r.type], ['Agency', r.agency], ['Office', r.office], ['NAICS', naicsText],
    ['Set-aside', r.set_aside], ['State/City', where], ['Posted', r.posted_at], ['Deadline', r.response_deadline],
    ['URL', r.url], ['SAM URL', r.sam_url], ['Solicitation', r.solicitation_number],
  ];
  let s = fields.filter(([, v]) => v).map(([k, v]) => `${(k + ':').padEnd(14)}${v}`).join('\n') + '\n';
  if (r.description) s += `\nDescription:\n${r.description}\n`;
  return s + `\nContacts:\n${contactLines(r.contacts, '  ')}`;
}

function contactLines(contacts, indent = '') {
  if (!contacts?.length) return `${indent}No contacts published.\n`;
  return contacts.map((c) => indent + [c.name, c.title].filter(Boolean).join(' — ')).join('\n') + '\n';
}

// --- entry point ---------------------------------------------------------------------------------------------

/** Run one command line. Returns the exit code: 0 ok, 1 API or network failure, 2 bad usage. */
export async function main(
  argv,
  { fetch = globalThis.fetch, env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  const out = (s) => stdout.write(s);
  const err = (s) => stderr.write(s.endsWith('\n') ? s : s + '\n');
  const [first, second] = argv;
  if (first === '--version') return out(`${VERSION}\n`), 0;
  if (first === undefined || first === '-h' || first === '--help') return out(MAIN_HELP), 0;
  let words;
  if (first === 'search') {
    if (second === undefined || second === '-h' || second === '--help') return out(SEARCH_HELP), 0;
    words = ['search', second];
  } else {
    words = [first];
  }
  const cmd = COMMANDS[words.join(' ')];
  if (!cmd) {
    err(`matchawards: unknown command '${words.join(' ')}'. Run \`matchawards --help\`.`);
    return 2;
  }
  const args = argv.slice(words.length);
  const name = `matchawards ${words.join(' ')}`;
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        options: Object.fromEntries(cmd.opts.map((k) => [k, OPTS[k][0]])),
        allowPositionals: Boolean(cmd.positional),
      });
    } catch (e) {
      throw new UsageError(e.message);
    }
    const { values, positionals } = parsed;
    if (values.help) return out(commandHelp(cmd)), 0;
    if (cmd.positional && positionals.length !== 1) {
      throw new UsageError(`${cmd.positional} is required, exactly once. Usage: ${cmd.usage}`);
    }
    const result = await cmd.run(values, positionals, { fetch, base: apiBase(env) });
    if (values.json) {
      out(JSON.stringify(result, null, 2) + '\n');
    } else if (words[0] === 'get') {
      out(record(result));
    } else if (words[0] === 'contacts') {
      out(contactLines(result.contacts));
    } else {
      out(table(result, stdout.columns));
      if (result.has_more && result.next_cursor) out(`More results: ${nextCommand(words, args, result.next_cursor)}\n`);
    }
    if (result.warning && !values.json) err(`Warning: ${result.warning}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${name}: ${e.message}`);
      return 2;
    }
    if (e instanceof ApiError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}
