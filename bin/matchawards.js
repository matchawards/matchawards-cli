#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // main() maps every failure to 1 or 2 itself; this is the last resort, so the exit codes stay 0/1/2.
  process.stderr.write(`matchawards: unexpected error: ${String(e?.message ?? e).replace(/[\x00-\x1f\x7f-\x9f]/g, '')}\n`);
  process.exitCode = 1;
}
