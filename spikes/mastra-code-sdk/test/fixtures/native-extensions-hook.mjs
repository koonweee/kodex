import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw);
assert.equal(process.cwd(), payload.cwd);
appendFileSync(process.argv[2], JSON.stringify({ kind: 'hook', scope: process.argv[3], ...payload }) + '\n');
process.stdout.write('{}');
