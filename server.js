import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, resolveOrigin, searchLibraries, getLibrary, RESOURCE_LABELS } from './server/libraries.js';
import { chatReply, aiEnabled } from './server/chat.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const STATIC_FILES = new Set([
  'index.html', 'search.html', 'map.html', 'faq.html', 'chatbot.html', 'app.js', 'styles.css',
  'data/library-data.json', 'data/content.json', 'data/nc-counties.geojson', 'assets/nc-landscape.svg'
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const data = loadData();

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const num = (value) => (value === null || value === '' ? NaN : Number(value));

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, libraries: data.libraries.length, ai: aiEnabled(), source: data.source });
  }

  if (req.method === 'GET' && p === '/api/meta') {
    return sendJson(res, 200, {
      source: data.source,
      libraryCount: data.libraries.length,
      systemCount: new Set(data.libraries.map((l) => l.system)).size,
      countyCount: new Set(data.libraries.map((l) => l.county)).size,
      resources: RESOURCE_LABELS,
      ai: aiEnabled()
    });
  }

  if (req.method === 'GET' && p === '/api/libraries') {
    const origin = resolveOrigin(data, { zip: q.get('zip'), lat: num(q.get('lat')), lng: num(q.get('lng')) });
    if (q.get('zip') && !origin) return sendJson(res, 400, { error: `ZIP code ${q.get('zip')} is not a known North Carolina ZIP.` });
    const resources = (q.get('resource') || '').split(',').filter((r) => r && r !== 'any');
    const limit = Math.min(Number(q.get('limit')) || 10, 500);
    const result = searchLibraries(data, {
      origin, resources, limit,
      query: q.get('q') || '',
      includeMobile: q.get('mobile') === '1'
    });
    return sendJson(res, 200, { origin, ...result });
  }

  const detail = p.match(/^\/api\/libraries\/([\w-]+)$/);
  if (req.method === 'GET' && detail) {
    const lib = getLibrary(data, detail[1]);
    return lib ? sendJson(res, 200, lib) : sendJson(res, 404, { error: 'Library not found' });
  }

  if (req.method === 'GET' && p === '/api/map-points') {
    // Compact list for drawing every marker on the map.
    return sendJson(res, 200, data.libraries.map((l) => [l.id, l.lat, l.lng, l.name]));
  }

  if (req.method === 'GET' && p === '/api/map-libraries') {
    // Everything the statewide map needs for pins, filters and popups.
    return sendJson(res, 200, data.libraries
      .filter((l) => l.type !== 'administration')
      .map((l) => ({
        id: l.id, name: l.name, system: l.system, county: l.county, city: l.city,
        address: l.address, zip: l.zip, phone: l.phone, hours: l.hours, url: l.url,
        type: l.type, lat: l.lat, lng: l.lng, resources: l.resources,
        unverifiedResources: l.unverifiedResources, approx: l.locationPrecision === 'zip'
      })));
  }

  if (req.method === 'GET' && p === '/api/content') {
    const featured = data.featuredLibraryIds.map((id) => getLibrary(data, id)).filter(Boolean);
    return sendJson(res, 200, { featured, workshops: data.workshops, digitalResources: data.digitalResources, faqs: data.faqs });
  }

  if (req.method === 'POST' && p === '/api/chat') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const message = String(payload.message || '').trim().slice(0, 1000);
    if (!message) return sendJson(res, 400, { error: 'message is required' });
    const history = Array.isArray(payload.history) ? payload.history : [];
    const location = payload.location && Number.isFinite(payload.location.lat) ? payload.location : null;
    return sendJson(res, 200, await chatReply(data, message, history, location));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function handleStatic(res, url) {
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!STATIC_FILES.has(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const body = await readFile(path.join(ROOT, name));
  res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request URL' });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await handleStatic(res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LightLibrary running at http://${HOST}:${PORT}  (${data.libraries.length} libraries, AI chat ${aiEnabled() ? 'on' : 'off - set ANTHROPIC_API_KEY to enable'})`);
});
