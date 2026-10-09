# matchawards

Search US government contract opportunities (federal and state), grants and jobs from
[matchawards.com](https://matchawards.com) on the command line. Read-only, no account, no API key,
zero dependencies (Node 18 or newer).

The CLI sibling of [matchawards-mcp](https://github.com/matchawards/matchawards-mcp): the same six tools, filters
and limits, for people and shell scripts instead of AI agents.

## Install

```sh
npx matchawards search contracts --naics 541511 --state VA
# or
npm install -g matchawards
```

## Commands

| Command | What it returns |
|---|---|
| `matchawards search contracts` | Federal and state contract opportunities. Filters: `--naics`, `--state`, `--keyword` (`-k`), `--set-aside`, `--level federal\|state`, `--days N` (1-180), `--include-closed`, `--limit N` (1-50, default 20), `--cursor`. |
| `matchawards search grants` | Federal grant and funding opportunities. Filters: `--naics`, `--keyword`, `--days`, `--include-closed`, `--limit`, `--cursor` (grant notices carry no state). |
| `matchawards search jobs` | Job postings from the last 30 days. Filters: `--naics`, `--state`, `--keyword`, `--days` (1-30, default 30), `--limit`, `--cursor`. |
| `matchawards naics <codes>` | The newest opportunities for up to 10 NAICS codes; `--type contract\|federal\|state\|grant\|job` (default contract), `--cursor`. |
| `matchawards get <id>` | The full record of one opportunity: description, deadline, agency and contacts. |
| `matchawards contacts <id>` | Only the published points of contact for one opportunity. |

```sh
matchawards search contracts --naics 238160 --state VA --keyword roof
matchawards search grants --keyword broadband
matchawards search jobs --keyword electrician --state TX --days 7
matchawards naics 541511,541512 --type federal
matchawards get 117402307943537453
matchawards contacts 117402307943537453
```

Searches return open items only (response deadline today or later, US Eastern) unless you pass `--include-closed`.
When more results exist the table ends with the exact command for the next page (`--cursor`).
`matchawards <command> --help` lists every option.

## Scripting

`--json` prints the result object instead of text: `{as_of, results, has_more, next_cursor}` for searches (plus
`warning` if a follow-up page failed), the full record for `get`, `{id, title, url, contacts}` for `contacts`.
Ids are strings; keep them that way (they exceed JavaScript's safe integer range).

```sh
matchawards search contracts --naics 541511 --limit 50 --json | jq -r '.results[].url'
```

Exit codes: 0 ok, 1 API or network error, 2 bad flag or argument.

## Configuration

`MATCHAWARDS_API_BASE` sets the API host (default `https://matchawards.com`).

The public API allows 60 requests per minute (20 per 5 seconds) per IP address. One search can make up to
3 requests while filling `--limit`.

## Data

The data is US federal and state contract opportunities, grants and jobs from
[matchawards.com](https://matchawards.com). Only public posts are returned, and each result links back to its page
on matchawards.com.

## License

MIT

## Releasing

Published from GitHub Actions with npm provenance, never from a laptop: bump `version` in `package.json`, commit,
then `git tag <version> && git push --tags`. `.github/workflows/publish.yml` checks the tag against the version,
runs the tests and publishes. npm auth is Trusted Publishing (OIDC), so no npm token is stored anywhere.
