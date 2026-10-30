import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData, resolveOrigin, searchLibraries, resourcesFromText, getLibrary } from '../server/libraries.js';
import { chatReply } from '../server/chat.js';

const data = loadData();

test('dataset loads real workbook records with coordinates inside NC', () => {
  assert.ok(data.libraries.length > 400);
  for (const lib of data.libraries) {
    assert.ok(lib.lat > 33.7 && lib.lat < 36.7, `${lib.name} lat ${lib.lat}`);
    assert.ok(lib.lng > -84.5 && lib.lng < -75.3, `${lib.name} lng ${lib.lng}`);
    assert.ok(lib.name && lib.system && lib.city && lib.zip);
  }
});

test('ids are unique and featured libraries exist', () => {
  assert.equal(new Set(data.libraries.map((l) => l.id)).size, data.libraries.length);
  for (const id of data.featuredLibraryIds) assert.ok(getLibrary(data, id), id);
});

const nearestCases = [
  ['27701', 'Durham'],
  ['28801', 'Asheville'],
  ['28401', 'Wilmington'],
  ['27401', 'Greensboro'],
  ['28202', 'Charlotte']
];
for (const [zip, city] of nearestCases) {
  test(`nearest library to ${zip} is in ${city}`, () => {
    const origin = resolveOrigin(data, { zip });
    const { results } = searchLibraries(data, { origin, limit: 3 });
    assert.equal(results[0].city, city);
    assert.ok(results[0].distanceMiles < 5);
    assert.ok(results[0].distanceMiles <= results[1].distanceMiles);
  });
}

test('unknown ZIP resolves to no origin', () => {
  assert.equal(resolveOrigin(data, { zip: '90210' }), null);
});

test('resource filter only returns libraries with that resource', () => {
  const origin = resolveOrigin(data, { zip: '27601' });
  const { results } = searchLibraries(data, { origin, resources: ['wifi', 'teens'], limit: 20 });
  assert.ok(results.length > 0);
  for (const lib of results) assert.ok(lib.resources.includes('wifi') && lib.resources.includes('teens'));
});

test('text search matches city and system names', () => {
  assert.ok(searchLibraries(data, { query: 'asheville' }).total > 0);
  assert.ok(searchLibraries(data, { query: 'wake county' }).total > 10);
});

test('mobile units are excluded unless requested', () => {
  const all = searchLibraries(data, { limit: 1000, includeMobile: true }).total;
  const fixed = searchLibraries(data, { limit: 1000 }).total;
  assert.ok(all > fixed);
});

test('natural language maps to resource tags', () => {
  assert.deepEqual(resourcesFromText('find a branch with wi-fi and job support near me').sort(), ['adults', 'wifi']);
});

test('rule-based chat answers nearest-library questions from real data', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const { reply, mode } = await chatReply(data, 'closest library to 27701');
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  assert.equal(mode, 'rules');
  assert.match(reply, /Durham/);
});

test('chat reuses a ZIP from earlier in the conversation', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const history = [{ role: 'user', content: 'closest library to 28801' }, { role: 'assistant', content: '...' }];
  const { libraries } = await chatReply(data, 'which of those have teen programs?', history);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  assert.ok(libraries.length > 0);
  assert.equal(libraries[0].city, 'Asheville');
});

test('chat recognizes county names', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const { libraries } = await chatReply(data, 'libraries in Wake County');
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  assert.ok(libraries.length > 0);
  assert.ok(libraries.every((l) => l.system.startsWith('Wake')));
});

test('county outlines cover all 100 NC counties', async () => {
  const { readFileSync } = await import('node:fs');
  const geo = JSON.parse(readFileSync(new URL('../data/nc-counties.geojson', import.meta.url), 'utf-8'));
  assert.equal(geo.features.length, 100);
});
