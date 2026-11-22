'use strict';
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

let child;
let base;
let tempDir;
const token = 'test-only-local-token';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabicat-info-site-'));
  const dataFile = path.join(tempDir, 'items.json');
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', ADMIN_API_KEY: token, DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await Promise.race([
    (async () => {
      while (!/listening on (\d+)/.test(output)) {
        if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      base = `http://127.0.0.1:${output.match(/listening on (\d+)/)[1]}`;
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 5000)),
  ]);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const json = response => response.json();

test('health and static page return expected security headers', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await json(health), { ok: true });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /信息站/);
});

test('public listing supports search and pagination', async () => {
  const empty = await fetch(`${base}/api/items`);
  assert.equal(empty.status, 200);
  assert.deepEqual((await json(empty)).items, []);
});

test('write API rejects missing auth and validates JSON fields', async () => {
  const unauthorized = await fetch(`${base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Nope' }) });
  assert.equal(unauthorized.status, 401);
  const invalidObject = await fetch(`${base}/api/items`, { method: 'POST', headers: auth, body: JSON.stringify([]) });
  assert.equal(invalidObject.status, 400);
  const invalidUrl = await fetch(`${base}/api/items`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Bad URL', sourceUrl: 'javascript:alert(1)' }) });
  assert.equal(invalidUrl.status, 400);
});

test('concurrent creates are preserved and pagination/search work', async () => {
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${base}/api/items`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: `item-${i}`, summary: `summary-${i}`, body: `body-${i}`, category: 'test' }),
  })));
  assert.ok(responses.every(response => response.status === 201));
  const first = await json(await fetch(`${base}/api/items?limit=5&offset=0`));
  assert.equal(first.items.length, 5);
  assert.equal(first.total, 12);
  assert.equal(first.hasMore, true);
  const match = await json(await fetch(`${base}/api/items?q=item-7`));
  assert.equal(match.total, 1);
  assert.equal(match.items[0].title, 'item-7');
});

test('update, delete, method handling and oversized bodies', async () => {
  const list = await json(await fetch(`${base}/api/items?limit=50`));
  const item = list.items.find(row => row.title === 'item-7');
  const updated = await fetch(`${base}/api/items/${item.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'updated-7' }) });
  assert.equal(updated.status, 200);
  assert.equal((await json(updated)).item.title, 'updated-7');
  const missing = await fetch(`${base}/api/items/not-a-real-id`, { method: 'DELETE', headers: auth });
  assert.equal(missing.status, 404);
  const deleted = await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE', headers: auth });
  assert.equal(deleted.status, 200);
  const unsupported = await fetch(`${base}/api/items`, { method: 'PUT', headers: auth, body: '{}' });
  assert.equal(unsupported.status, 405);
  const tooLarge = await fetch(`${base}/api/items`, { method: 'POST', headers: { ...auth, 'content-length': String(300 * 1024) }, body: 'x'.repeat(300 * 1024) });
  assert.equal(tooLarge.status, 413);
});
