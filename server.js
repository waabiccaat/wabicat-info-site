'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Read a private local .env file before accessing process.env. Keep .env out of Git.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      process.env[match[1]] = value;
    }
  }
}

const PORT = Number(process.env.PORT || 6688);
const TOKEN = process.env.ADMIN_API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'items.json');
const WEB_ROOT = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 256 * 1024;

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

function readItems() {
  let contents;
  try {
    contents = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(contents);
  if (!Array.isArray(parsed)) throw new Error('Content store must contain a JSON array.');
  return parsed;
}

function writeItems(items) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  // A unique temp file avoids collisions between simultaneous writes and stale temp files.
  const temp = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(items, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, DATA_FILE);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('Could not remove temporary content file.'); }
    throw err;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function safeItem(item) {
  return {
    id: item.id, title: item.title, summary: item.summary, body: item.body,
    category: item.category, sourceUrl: item.sourceUrl,
    publishedAt: item.publishedAt, updatedAt: item.updatedAt,
  };
}

async function readBody(req) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    req.resume();
    throw Object.assign(new Error('Request body is too large (256 KiB limit).'), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) throw Object.assign(new Error('Request body is too large (256 KiB limit).'), { status: 413 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Body must be valid JSON.'), { status: 400 }); }
}

function text(value, max, field, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw Object.assign(new Error(`${field} must be text.`), { status: 400 });
  const result = value.trim();
  if (required && !result) throw Object.assign(new Error(`${field} is required.`), { status: 400 });
  if (result.length > max) throw Object.assign(new Error(`${field} must be at most ${max} characters.`), { status: 400 });
  return result;
}

function inputFields(data, old = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(new Error('Body must be a JSON object.'), { status: 400 });
  }
  const title = data.title === undefined ? old.title : text(data.title, 180, 'title', true);
  const summary = data.summary === undefined ? old.summary || '' : text(data.summary, 500, 'summary');
  const body = data.body === undefined ? old.body || '' : text(data.body, 12000, 'body');
  const category = data.category === undefined ? old.category || '资讯' : text(data.category, 60, 'category');
  const sourceUrl = data.sourceUrl === undefined ? old.sourceUrl || '' : text(data.sourceUrl, 2048, 'sourceUrl');
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error();
    } catch {
      throw Object.assign(new Error('sourceUrl must be a valid http(s) URL.'), { status: 400 });
    }
  }
  return { title, summary, body, category, sourceUrl };
}

// Serialize read-modify-write operations so concurrent API requests cannot overwrite each other.
let storeQueue = Promise.resolve();
function withStoreLock(task) {
  const operation = storeQueue.then(task, task);
  storeQueue = operation.catch(() => {});
  return operation;
}

function authorized(req) {
  if (!TOKEN) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const provided = bearer ? bearer[1] : (req.headers['x-admin-token'] || '');
  const a = Buffer.from(String(provided));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/api/items') {
    try {
      const q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
      const all = readItems().sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
      const filtered = q
        ? all.filter(item => [item.title, item.summary, item.body, item.category]
          .some(value => String(value || '').toLocaleLowerCase().includes(q)))
        : all;
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
      const limit = Math.min(50, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));
      const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const offset = Math.min(filtered.length, Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0));
      const items = filtered.slice(offset, offset + limit).map(safeItem);
      return send(res, 200, { items, total: filtered.length, offset, limit, hasMore: offset + items.length < filtered.length }, { 'cache-control': 'public, max-age=30' });
    } catch {
      return send(res, 500, { error: 'Could not read published content.' });
    }
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return send(res, TOKEN ? 401 : 503, { error: TOKEN ? 'A valid API token is required.' : 'Publishing API is not configured yet.' });
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'POST' && url.pathname === '/api/items') {
        const data = await readBody(req);
        return await withStoreLock(() => {
          const items = readItems();
          const now = new Date().toISOString();
          const item = { id: crypto.randomUUID(), ...inputFields(data), publishedAt: now, updatedAt: now };
          items.push(item);
          writeItems(items);
          return send(res, 201, { item: safeItem(item) });
        });
      }
      if (parts.length === 3 && parts[1] === 'items') {
        let id;
        try { id = decodeURIComponent(parts[2]); }
        catch { return send(res, 400, { error: 'Item id is not valid URL encoding.' }); }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const data = await readBody(req);
          return await withStoreLock(() => {
            const items = readItems();
            const index = items.findIndex(item => item.id === id);
            if (index < 0) return send(res, 404, { error: 'Item not found.' });
            items[index] = { ...items[index], ...inputFields(data, items[index]), updatedAt: new Date().toISOString() };
            writeItems(items);
            return send(res, 200, { item: safeItem(items[index]) });
          });
        }
        if (req.method === 'DELETE') {
          return await withStoreLock(() => {
            const items = readItems();
            const index = items.findIndex(item => item.id === id);
            if (index < 0) return send(res, 404, { error: 'Item not found.' });
            const [deleted] = items.splice(index, 1);
            writeItems(items);
            return send(res, 200, { deleted: { id: deleted.id } });
          });
        }
      }
      return send(res, 405, { error: 'Unsupported API method or route.' }, { allow: 'GET, POST, PATCH, PUT, DELETE' });
    } catch (err) {
      return send(res, err.status || 500, { error: err.status ? err.message : 'Could not save content.' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' }, { allow: 'GET, HEAD' });
  let requested;
  try { requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
  catch { return send(res, 400, { error: 'Invalid URL path.' }); }
  const file = path.resolve(WEB_ROOT, requested);
  if (!file.startsWith(WEB_ROOT + path.sep)) return send(res, 404, { error: 'Not found.' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found.' });
    const nonce = crypto.randomBytes(18).toString('base64');
    const body = path.extname(file) === '.html' ? Buffer.from(data.toString('utf8').replaceAll('__CSP_NONCE__', nonce)) : data;
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, { error: 'Unexpected server error.' });
    else res.destroy();
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(PORT, '0.0.0.0', () => console.log(`Public information site listening on ${server.address().port}`));
