// Live smoke test against staging (2 requests): run by hand with `npm run smoke`. Exits non-zero on failure.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/matchawards.js', import.meta.url));
const env = { ...process.env, MATCHAWARDS_API_BASE: process.env.MATCHAWARDS_API_BASE || 'https://staging.matchawards.com' };
const cli = (...args) => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });

const found = JSON.parse(cli('search', 'contracts', '--naics', '541511', '--limit', '2', '--json'));
const id = found.results[0]?.id;
if (typeof id !== 'string' || !found.as_of) throw new Error(`unexpected search result: ${JSON.stringify(found)}`);
const record = cli('get', id);
if (!record.includes('URL:')) throw new Error(`unexpected get output:\n${record}`);
console.log(`smoke ok (${env.MATCHAWARDS_API_BASE}): ${found.results.length} results, get ${id}: ${record.split('\n')[0]}`);
