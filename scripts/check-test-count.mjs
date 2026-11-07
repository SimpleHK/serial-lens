#!/usr/bin/env node
/**
 * Auto-syncs the unit-test count in README.md with the suite that just ran
 * (`npm test` writes .vitest-count.json via the JSON reporter). The count
 * changes every feature round and hand-syncing drifted twice (README said
 * 141 while the suite was at 145), so the count is machine-owned now: this
 * script patches README.md in place and exits 0. CI follows up with
 * `git diff --exit-code -- README.md`, so a stale count still fails there.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = JSON.parse(readFileSync(path.join(root, '.vitest-count.json'), 'utf8'));
const total = results.numTotalTests;
if (!Number.isInteger(total) || total <= 0) {
  console.error(`check-test-count: .vitest-count.json has no usable numTotalTests (${total})`);
  process.exit(1);
}

const readmePath = path.join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const marker = /(\d+) unit tests/;
const m = readme.match(marker);
if (!m) {
  console.error('check-test-count: README.md lost its "N unit tests" marker line');
  process.exit(1);
}
if (Number(m[1]) === total) {
  console.log(`check-test-count: README count ${m[1]} matches the suite (${total})`);
  process.exit(0);
}
writeFileSync(readmePath, readme.replace(marker, `${total} unit tests`));
console.log(`check-test-count: README count ${m[1]} -> ${total} (auto-synced; stage the README change before committing)`);
