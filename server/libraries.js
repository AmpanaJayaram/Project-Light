import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');

export const RESOURCE_LABELS = {
  books: 'Books',
  computer: 'Public computers',
  wifi: 'Wi-Fi',
  research: 'Research databases',
  kids: 'Kids programs',
  family: 'Family programs',
  teens: 'Teen programs',
  adults: 'Adult programs'
};

// Free-text words people use, mapped to the tags present in the dataset.
const RESOURCE_SYNONYMS = {
  books: ['book', 'books', 'read', 'reading', 'ebook', 'audiobook', 'novel'],
  computer: ['computer', 'computers', 'laptop', 'printer', 'printing', 'internet', 'technology', 'tech'],
  wifi: ['wifi', 'wi-fi', 'wireless', 'hotspot'],
  research: ['research', 'database', 'databases', 'homework', 'study', 'genealogy', 'history', 'health', 'ged'],
  kids: ['kid', 'kids', 'child', 'children', 'storytime', 'toddler'],
  family: ['family', 'families', 'parent', 'parents'],
  teens: ['teen', 'teens', 'teenager', 'youth'],
  adults: ['adult', 'adults', 'job', 'jobs', 'career', 'resume', 'senior', 'seniors']
};

export function loadData() {
  const libraryData = JSON.parse(readFileSync(path.join(DATA_DIR, 'library-data.json'), 'utf-8'));
  const content = JSON.parse(readFileSync(path.join(DATA_DIR, 'content.json'), 'utf-8'));
  return { ...libraryData, ...content };
}

export function distanceMiles(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

export function resourcesFromText(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z0-9-]+/);
  return Object.keys(RESOURCE_SYNONYMS).filter((tag) =>
    RESOURCE_SYNONYMS[tag].some((syn) => words.includes(syn))
  );
}

export function resolveOrigin(data, { zip, lat, lng }) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, label: 'your location' };
  const zip5 = String(zip || '').trim().slice(0, 5);
  const coords = data.zips[zip5];
  if (coords) return { lat: coords[0], lng: coords[1], label: `ZIP ${zip5}` };
  return null;
}

/**
 * Rank libraries by distance from an origin.
 * resources: list of tags that must all be present.
 * query: optional text matched against name, system, city and county.
 */
export function searchLibraries(data, { origin, resources = [], query = '', limit = 10, includeMobile = false }) {
  const q = query.trim().toLowerCase();
  const wanted = resources.filter((r) => RESOURCE_LABELS[r]);

  let list = data.libraries.filter((lib) => {
    if (lib.type === 'administration') return false;
    if (!includeMobile && lib.type === 'mobile') return false;
    if (wanted.some((tag) => !lib.resources.includes(tag))) return false;
    if (q) {
      const haystack = `${lib.name} ${lib.system} ${lib.city} ${lib.county}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (origin) {
    list = list
      .map((lib) => ({ ...lib, distanceMiles: +distanceMiles(origin.lat, origin.lng, lib.lat, lib.lng).toFixed(1) }))
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
  } else {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  }

  return { total: list.length, results: list.slice(0, limit) };
}

export function getLibrary(data, id) {
  return data.libraries.find((lib) => lib.id === id || lib.outletId === id) || null;
}
