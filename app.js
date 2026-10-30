// LightLibrary front end. Talks to the Node API (server.js); if the API is not
// available (e.g. static hosting) it falls back to the JSON files in data/.

const RESOURCE_LABELS = {
  books: 'Books',
  computer: 'Public computers',
  wifi: 'Wi-Fi',
  research: 'Research databases',
  kids: 'Kids programs',
  family: 'Family programs',
  teens: 'Teen programs',
  adults: 'Adult programs'
};

const APP_STATE = {
  mode: null, // 'api' | 'static'
  staticData: null,
  currentCoordinates: null
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function fetchJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status });
  return body;
}

async function detectMode() {
  if (APP_STATE.mode) return APP_STATE.mode;
  try {
    await fetchJson('/api/health');
    APP_STATE.mode = 'api';
  } catch {
    const [libraryData, content] = await Promise.all([
      fetchJson('data/library-data.json'),
      fetchJson('data/content.json')
    ]);
    APP_STATE.staticData = { ...libraryData, ...content };
    APP_STATE.mode = 'static';
  }
  return APP_STATE.mode;
}

// ---- static-mode equivalents of the API (same logic as server/libraries.js) ----

function distanceMiles(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

function staticSearch({ zip, lat, lng, resource, q, limit }) {
  const data = APP_STATE.staticData;
  let origin = null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) origin = { lat, lng, label: 'your location' };
  else if (zip) {
    const coords = data.zips[zip];
    if (!coords) throw new Error(`ZIP code ${zip} is not a known North Carolina ZIP.`);
    origin = { lat: coords[0], lng: coords[1], label: `ZIP ${zip}` };
  }
  const query = (q || '').toLowerCase();
  let list = data.libraries.filter((lib) =>
    lib.type !== 'mobile' && lib.type !== 'administration'
    && (!resource || lib.resources.includes(resource))
    && (!query || `${lib.name} ${lib.system} ${lib.city} ${lib.county}`.toLowerCase().includes(query))
  );
  if (origin) {
    list = list.map((lib) => ({ ...lib, distanceMiles: +distanceMiles(origin.lat, origin.lng, lib.lat, lib.lng).toFixed(1) }))
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { origin, total: list.length, results: list.slice(0, limit) };
}

// ---- data access used by the pages ----

const api = {
  async meta() {
    if (await detectMode() === 'api') return fetchJson('/api/meta');
    const libs = APP_STATE.staticData.libraries;
    return {
      libraryCount: libs.length,
      systemCount: new Set(libs.map((l) => l.system)).size,
      countyCount: new Set(libs.map((l) => l.county)).size,
      ai: false
    };
  },
  async content() {
    if (await detectMode() === 'api') return fetchJson('/api/content');
    const d = APP_STATE.staticData;
    return {
      featured: d.featuredLibraryIds.map((id) => d.libraries.find((l) => l.id === id)).filter(Boolean),
      workshops: d.workshops,
      digitalResources: d.digitalResources,
      faqs: d.faqs
    };
  },
  async search(params) {
    if (await detectMode() === 'static') return staticSearch(params);
    const qs = new URLSearchParams();
    if (params.zip) qs.set('zip', params.zip);
    if (Number.isFinite(params.lat)) { qs.set('lat', params.lat); qs.set('lng', params.lng); }
    if (params.resource) qs.set('resource', params.resource);
    if (params.q) qs.set('q', params.q);
    qs.set('limit', params.limit);
    return fetchJson(`/api/libraries?${qs}`);
  },
  async mapPoints() {
    if (await detectMode() === 'api') return fetchJson('/api/map-points');
    return APP_STATE.staticData.libraries.map((l) => [l.id, l.lat, l.lng, l.name]);
  },
  async mapLibraries() {
    if (await detectMode() === 'api') return fetchJson('/api/map-libraries');
    return APP_STATE.staticData.libraries
      .filter((l) => l.type !== 'administration')
      .map((l) => ({ ...l, approx: l.locationPrecision === 'zip' }));
  },
  counties() {
    return fetchJson('data/nc-counties.geojson');
  },
  async chat(message, history) {
    if (await detectMode() === 'api') {
      return fetchJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, location: APP_STATE.currentCoordinates })
      });
    }
    return { reply: await staticChatReply(message), mode: 'rules' };
  }
};

async function staticChatReply(message) {
  const zip = (message.match(/\b2[78]\d{3}\b/) || [])[0];
  if (!zip) return 'Tell me your NC ZIP code (for example "closest library to 27601") and I will find the nearest branches. The full assistant needs the LightLibrary server running.';
  const { results } = staticSearch({ zip, limit: 3 });
  const best = results[0];
  return `The closest library to ZIP ${zip} is ${best.name} (${best.system}), about ${best.distanceMiles} miles away at ${best.address}, ${best.city}. Phone: ${best.phone}.`;
}

// ---- shared rendering ----

// The workbook only has a website per library system, so each branch gets a
// Google Maps place link (its own listing: website, hours, phone) plus the
// system site, labelled with the system's name.
function libraryLinks(lib) {
  const place = encodeURIComponent(`${lib.name}, ${lib.address}, ${lib.city}, NC ${lib.zip}`);
  const links = [
    `<a href="https://www.google.com/maps/dir/?api=1&destination=${place}" target="_blank" rel="noopener">Directions</a>`,
    `<a href="https://www.google.com/maps/search/?api=1&query=${place}" target="_blank" rel="noopener" title="This branch's listing: its own website, hours and phone">Branch info</a>`
  ];
  if (lib.url) {
    links.push(`<a href="${escapeHtml(lib.url)}" target="_blank" rel="noopener" title="Website for all ${escapeHtml(lib.system)} branches">${escapeHtml(lib.system)} site</a>`);
  }
  return links.join('');
}

function libraryCard(lib, { compact = false } = {}) {
  const unverified = lib.unverifiedResources || [];
  const tags = lib.resources.slice(0, compact ? 3 : 5).map((tag) => unverified.includes(tag)
    ? `<span title="This library system did not report this service">${escapeHtml(RESOURCE_LABELS[tag] || tag)} (not reported)</span>`
    : `<span>${escapeHtml(RESOURCE_LABELS[tag] || tag)}</span>`).join('');
  const approx = lib.locationPrecision === 'zip' ? ' <span class="approx" title="Placed at the ZIP code center">approx. location</span>' : '';
  return `
    <div class="result-header">
      <div>
        <div class="label-pill">${escapeHtml(lib.city)} · ${escapeHtml(lib.county)} County</div>
        <h3>${escapeHtml(lib.name)}</h3>
        <p class="muted">${escapeHtml(lib.system)}</p>
      </div>
      ${lib.distanceMiles != null ? `<div class="result-distance">${lib.distanceMiles} mi</div>` : ''}
    </div>
    <p class="address">${escapeHtml(lib.address)}, ${escapeHtml(lib.city)}, NC ${escapeHtml(lib.zip)}${approx}</p>
    <p>${escapeHtml(lib.phone)} · ${escapeHtml(lib.hours)}</p>
    <div class="meta-list">${tags}</div>
    <div class="links">
      ${libraryLinks(lib)}
    </div>`;
}

function showError(container, message) {
  if (container) container.innerHTML = `<div class="error-state">${escapeHtml(message)}</div>`;
}

// ---- home page ----

async function renderHomePage() {
  const featuredEl = document.getElementById('featuredLibraries');
  const workshopEl = document.getElementById('workshopList');
  const resourcesEl = document.getElementById('digitalResources');
  const statEls = document.querySelectorAll('[data-stat]');
  if (!featuredEl && !workshopEl && !resourcesEl && !statEls.length) return;

  try {
    const [meta, content] = await Promise.all([api.meta(), api.content()]);
    statEls.forEach((el) => { el.textContent = meta[el.dataset.stat] ?? '–'; });

    if (featuredEl) {
      featuredEl.innerHTML = content.featured.map((lib) => `
        <article class="feature-card">
          <div class="label-pill">${escapeHtml(lib.system)}</div>
          <h3>${escapeHtml(lib.name)}</h3>
          <p>${escapeHtml(lib.address)}, ${escapeHtml(lib.city)}, NC ${escapeHtml(lib.zip)} · ${escapeHtml(lib.programHighlights[0] || '')}</p>
          <div class="card-footer">
            <span class="tiny">${lib.resources.length} services · ${escapeHtml(lib.hours)}</span>
            <a href="search.html?zip=${encodeURIComponent(lib.zip)}" class="button secondary" style="padding: 10px 12px; font-size: 0.88rem;">Find nearby</a>
          </div>
        </article>`).join('');
    }

    if (workshopEl) {
      workshopEl.innerHTML = content.workshops.map((w) => `
        <article class="workshop-card">
          <div class="label-pill">${escapeHtml(w.category)}${w.sample ? ' · Sample' : ''}</div>
          <h3>${escapeHtml(w.title)}</h3>
          <p>${escapeHtml(w.city)} · ${escapeHtml(w.date)} · ${escapeHtml(w.time)}</p>
          <div class="card-footer">
            <span class="tiny">${escapeHtml(w.format)}</span>
            <span class="tiny">${escapeHtml(w.audience)}</span>
          </div>
        </article>`).join('');
    }

    if (resourcesEl) {
      resourcesEl.innerHTML = content.digitalResources.map((r) => `
        <article class="resource-card">
          <div class="label-pill">${escapeHtml(r.category)}</div>
          <h3>${escapeHtml(r.title)}</h3>
          <p>${escapeHtml(r.description)}</p>
          <div class="card-footer">
            <span class="tiny">${r.needsCard ? 'Library card required' : 'Free access'}</span>
            <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="button secondary" style="padding: 10px 12px; font-size: 0.88rem;">Open</a>
          </div>
        </article>`).join('');
    }
  } catch (error) {
    statEls.forEach((el) => { el.textContent = '–'; });
    showError(featuredEl, 'Library data could not be loaded. Start the server with "npm start" and open http://localhost:3000.');
  }
}

// ---- search page ----

function createMap(container) {
  if (!container || typeof L === 'undefined') return null;
  container.innerHTML = '<div id="leafletMap"></div>';
  const map = L.map('leafletMap', { scrollWheelZoom: false }).setView([35.5, -79.4], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  return {
    map,
    background: L.layerGroup().addTo(map),
    results: L.layerGroup().addTo(map),
    markersById: new Map()
  };
}

const dotIcon = (cls, size) => L.divIcon({ className: cls, iconSize: [size, size] });

async function renderSearchPage() {
  const form = document.getElementById('searchForm');
  if (!form) return;

  const input = document.getElementById('searchZip');
  const resourceSelect = document.getElementById('resourceType');
  const resultsEl = document.getElementById('searchResults');
  const summary = document.getElementById('searchSummary');
  const geoButton = document.getElementById('geoButton');
  const chips = document.querySelectorAll('#filterChips button');
  const mapState = createMap(document.getElementById('mapBox'));

  const params = new URLSearchParams(location.search);
  if (params.get('zip')) input.value = params.get('zip');
  if (params.get('resource')) resourceSelect.value = params.get('resource');

  if (mapState) {
    api.mapPoints().then((points) => {
      points.forEach(([, lat, lng, name]) => {
        L.marker([lat, lng], { icon: dotIcon('lib-marker dim', 8), title: name, keyboard: false }).addTo(mapState.background);
      });
    }).catch(() => {});
  }

  const syncChips = () => chips.forEach((chip) => chip.classList.toggle('active', chip.dataset.resource === resourceSelect.value));

  const drawResults = (origin, results) => {
    if (!mapState) return;
    mapState.results.clearLayers();
    mapState.markersById.clear();
    const bounds = [];
    results.forEach((lib, index) => {
      const marker = L.marker([lib.lat, lib.lng], { icon: dotIcon(index === 0 ? 'lib-marker best' : 'lib-marker', index === 0 ? 18 : 13), zIndexOffset: 1000 - index })
        .bindPopup(`<strong>${escapeHtml(lib.name)}</strong><br>${escapeHtml(lib.address)}, ${escapeHtml(lib.city)}${lib.distanceMiles != null ? `<br>${lib.distanceMiles} mi` : ''}`)
        .addTo(mapState.results);
      mapState.markersById.set(lib.id, marker);
      bounds.push([lib.lat, lib.lng]);
    });
    if (origin) {
      L.marker([origin.lat, origin.lng], { icon: dotIcon('you-marker', 16), zIndexOffset: 2000 }).bindPopup(escapeHtml(origin.label)).addTo(mapState.results);
      bounds.push([origin.lat, origin.lng]);
    }
    if (bounds.length) mapState.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
  };

  const runSearch = async () => {
    const raw = input.value.trim();
    const resource = resourceSelect.value === 'any' ? '' : resourceSelect.value;
    const isZip = /^\d{5}$/.test(raw);
    const searchParams = { resource, limit: 10 };

    if (APP_STATE.currentCoordinates && !raw) Object.assign(searchParams, APP_STATE.currentCoordinates);
    else if (isZip) searchParams.zip = raw;
    else if (raw) { searchParams.q = raw; searchParams.limit = 25; }
    else {
      summary.textContent = 'Enter a ZIP code, city or library name, or use your location.';
      return;
    }

    summary.textContent = 'Searching…';
    resultsEl.innerHTML = '<div class="loading">Finding libraries…</div>';
    syncChips();

    try {
      const { origin, total, results } = await api.search(searchParams);
      if (!results.length) {
        resultsEl.innerHTML = '<div class="empty-state">No library matched that search. Try a different ZIP code or city, or choose "Any library".</div>';
        summary.textContent = 'No results';
        drawResults(origin, []);
        return;
      }
      const label = resource ? ` with ${RESOURCE_LABELS[resource].toLowerCase()}` : '';
      summary.textContent = origin
        ? `Closest ${results.length} libraries${label} to ${origin.label}.`
        : `${total} libraries${label} matching "${raw}"${total > results.length ? `, showing ${results.length}` : ''}.`;

      resultsEl.innerHTML = results.map((lib, index) => `
        <article class="result-card ${index === 0 && origin ? 'highlight' : ''}" data-id="${escapeHtml(lib.id)}" tabindex="0">
          ${libraryCard(lib)}
        </article>`).join('');
      drawResults(origin, results);
    } catch (error) {
      summary.textContent = 'Search failed';
      showError(resultsEl, error.message || 'Something went wrong. Please try again.');
    }
  };

  resultsEl.addEventListener('click', (event) => {
    const card = event.target.closest('.result-card');
    if (!card || event.target.closest('a') || !mapState) return;
    const marker = mapState.markersById.get(card.dataset.id);
    if (marker) {
      mapState.map.setView(marker.getLatLng(), Math.max(mapState.map.getZoom(), 12));
      marker.openPopup();
    }
    resultsEl.querySelectorAll('.result-card.selected').forEach((el) => el.classList.remove('selected'));
    card.classList.add('selected');
  });

  chips.forEach((chip) => chip.addEventListener('click', () => {
    resourceSelect.value = chip.dataset.resource;
    runSearch();
  }));

  input.addEventListener('input', () => { if (input.value.trim()) APP_STATE.currentCoordinates = null; });

  geoButton?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      summary.textContent = 'Location is not available in this browser. Please enter a ZIP code.';
      return;
    }
    summary.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        APP_STATE.currentCoordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
        input.value = '';
        runSearch();
      },
      () => { summary.textContent = 'We could not access your location. Please enter a ZIP code instead.'; },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  runSearch();
}

// ---- statewide map (map page + home section) ----

function popupHtml(lib) {
  return `<strong>${escapeHtml(lib.name)}</strong><br>
    <span class="muted">${escapeHtml(lib.system)}</span><br>
    ${escapeHtml(lib.address)}, ${escapeHtml(lib.city)} ${escapeHtml(lib.zip)}${lib.approx ? ' <em>(approx. location)</em>' : ''}<br>
    ${escapeHtml(lib.phone)} · ${escapeHtml(lib.hours)}
    <div class="popup-links">${libraryLinks(lib)}</div>`;
}

async function renderStateMap() {
  const host = document.querySelector('[data-state-map]');
  if (!host) return;
  if (typeof L === 'undefined') {
    showError(host, 'The map library could not be loaded. Check your internet connection and refresh.');
    return;
  }
  const full = host.dataset.stateMap === 'full';

  host.innerHTML = `
    ${full ? `
    <div class="statemap-toolbar">
      <div class="field"><label for="mapSearch">Library, city or county</label><input id="mapSearch" type="search" placeholder="e.g. Pack Memorial, Boone, Wake" /></div>
      <div class="field"><label for="mapResource">Service</label><select id="mapResource"><option value="">Any service</option>${Object.entries(RESOURCE_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div>
      <div class="field"><label for="mapSystem">Library system</label><select id="mapSystem"><option value="">All systems</option></select></div>
    </div>` : ''}
    <p class="statemap-summary muted" role="status" aria-live="polite">Loading libraries…</p>
    <div class="statemap-layout ${full ? '' : 'compact'}">
      <div class="statemap-canvas" id="stateMapCanvas"></div>
      ${full ? '<aside class="statemap-side" id="stateMapSide" aria-live="polite"></aside>' : ''}
    </div>
    <div class="statemap-legend">
      <span><i style="background:#1d4e89"></i>Library branch</span>
      <span><i style="background:#fff;box-shadow:0 0 0 2px #1d4e89"></i>Approximate location (ZIP center)</span>
      <span>Click a county to ${full ? 'list its libraries' : 'see how many libraries it has'}</span>
    </div>`;

  const summary = host.querySelector('.statemap-summary');
  const side = host.querySelector('#stateMapSide');
  const map = L.map('stateMapCanvas', { scrollWheelZoom: full, zoomSnap: 0.25 }).setView([35.35, -79.6], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    opacity: 0.55,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  let libraries;
  let counties;
  try {
    [libraries, counties] = await Promise.all([api.mapLibraries(), api.counties()]);
  } catch {
    summary.textContent = 'Library data could not be loaded.';
    return;
  }

  const byCounty = new Map();
  libraries.forEach((lib) => {
    if (!byCounty.has(lib.county)) byCounty.set(lib.county, []);
    byCounty.get(lib.county).push(lib);
  });

  let selectedCounty = null;
  let visible = libraries;

  const countyStyle = (feature) => {
    const name = feature.properties.n;
    const hasMatch = visible.some((lib) => lib.county === name);
    return {
      color: name === selectedCounty ? '#B31B1B' : '#8fa9c4',
      weight: name === selectedCounty ? 2.5 : 1,
      fillColor: '#1d4e89',
      fillOpacity: name === selectedCounty ? 0.16 : hasMatch ? 0.05 : 0
    };
  };

  const countyLayer = L.geoJSON(counties, {
    style: countyStyle,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.n;
      layer.bindTooltip(() => {
        const n = visible.filter((lib) => lib.county === name).length;
        return `${escapeHtml(name)} County · ${n} ${n === 1 ? 'library' : 'libraries'}`;
      }, { sticky: true });
      layer.on('click', () => selectCounty(selectedCounty === name ? null : name, layer));
    }
  }).addTo(map);
  // ?region= from the home page's region cards (approximate boundaries).
  const REGION_BOUNDS = {
    mountains: [[34.95, -84.33], [36.6, -80.9]],
    piedmont: [[34.75, -81.1], [36.6, -78.3]],
    coast: [[33.8, -78.7], [36.6, -75.4]]
  };
  let regionBounds = full ? REGION_BOUNDS[new URLSearchParams(location.search).get('region')] : null;
  const fitState = () => {
    map.invalidateSize();
    map.fitBounds(regionBounds || countyLayer.getBounds(), { padding: [10, 10] });
  };
  fitState();
  new ResizeObserver(() => { if (!selectedCounty) fitState(); }).observe(document.getElementById('stateMapCanvas'));

  const pins = L.layerGroup().addTo(map);
  const pinById = new Map();
  libraries.forEach((lib) => {
    const marker = L.circleMarker([lib.lat, lib.lng], {
      radius: 5.5,
      color: lib.approx ? '#1d4e89' : '#ffffff',
      weight: lib.approx ? 2 : 1.5,
      fillColor: lib.approx ? '#ffffff' : '#1d4e89',
      fillOpacity: 1
    }).bindPopup(() => popupHtml(lib)).bindTooltip(escapeHtml(lib.name), { direction: 'top', offset: [0, -4] });
    pinById.set(lib.id, marker);
  });

  function renderSide() {
    if (!side) return;
    if (!selectedCounty) {
      const counts = [...byCounty.entries()]
        .map(([county]) => [county, visible.filter((lib) => lib.county === county).length])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
      side.innerHTML = `
        <h3>All of North Carolina</h3>
        <div class="count">${visible.length}</div>
        <p class="muted">libraries in ${counts.length} counties. Click a county on the map, or pick one below.</p>
        <ul>${counts.slice(0, 40).map(([county, n]) => `<li><button type="button" data-county="${escapeHtml(county)}">${escapeHtml(county)} County<small>${n} ${n === 1 ? 'library' : 'libraries'}</small></button></li>`).join('')}</ul>`;
      return;
    }
    const list = visible.filter((lib) => lib.county === selectedCounty).sort((a, b) => a.name.localeCompare(b.name));
    side.innerHTML = `
      <button type="button" class="button secondary" data-county="" style="padding:6px 12px;font-size:.85rem">← All counties</button>
      <h3 style="margin-top:12px">${escapeHtml(selectedCounty)} County</h3>
      <div class="count">${list.length}</div>
      <p class="muted">${list.length === 1 ? 'library' : 'libraries'}${list.length ? ` · ${escapeHtml([...new Set(list.map((l) => l.system))].join(', '))}` : ' match the current filters'}</p>
      <ul>${list.map((lib) => `<li><button type="button" data-lib="${escapeHtml(lib.id)}">${escapeHtml(lib.name)}<small>${escapeHtml(lib.address)}, ${escapeHtml(lib.city)}</small></button></li>`).join('')}</ul>`;
  }

  function selectCounty(name, layer) {
    selectedCounty = name;
    countyLayer.setStyle(countyStyle);
    if (name) {
      const target = layer || countyLayer.getLayers().find((l) => l.feature.properties.n === name);
      if (target) map.fitBounds(target.getBounds(), { padding: [30, 30] });
      if (!side) {
        const n = visible.filter((lib) => lib.county === name).length;
        summary.textContent = `${name} County: ${n} ${n === 1 ? 'library' : 'libraries'}. Click a pin for details.`;
      }
    } else {
      regionBounds = null;
      fitState();
      updateSummary();
    }
    renderSide();
  }

  function updateSummary() {
    const countyCount = new Set(visible.map((lib) => lib.county)).size;
    summary.textContent = visible.length === libraries.length
      ? `${libraries.length} libraries across ${countyCount} counties.`
      : `Showing ${visible.length} of ${libraries.length} libraries in ${countyCount} counties.`;
  }

  function applyFilters() {
    const q = (host.querySelector('#mapSearch')?.value || '').trim().toLowerCase();
    const resource = host.querySelector('#mapResource')?.value || '';
    const system = host.querySelector('#mapSystem')?.value || '';
    visible = libraries.filter((lib) =>
      (!resource || lib.resources.includes(resource))
      && (!system || lib.system === system)
      && (!q || `${lib.name} ${lib.city} ${lib.county} ${lib.system}`.toLowerCase().includes(q))
    );
    pins.clearLayers();
    visible.forEach((lib) => pinById.get(lib.id).addTo(pins));
    countyLayer.setStyle(countyStyle);
    updateSummary();
    renderSide();
    if ((q || system) && visible.length && visible.length < libraries.length) {
      map.fitBounds(L.latLngBounds(visible.map((lib) => [lib.lat, lib.lng])), { padding: [40, 40], maxZoom: 12 });
    }
  }

  if (full) {
    const systemSelect = host.querySelector('#mapSystem');
    [...new Set(libraries.map((lib) => lib.system))].sort().forEach((name) => {
      systemSelect.insertAdjacentHTML('beforeend', `<option>${escapeHtml(name)}</option>`);
    });
    let timer;
    host.querySelector('#mapSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(applyFilters, 200); });
    host.querySelector('#mapResource').addEventListener('change', applyFilters);
    systemSelect.addEventListener('change', applyFilters);
    side.addEventListener('click', (event) => {
      const countyBtn = event.target.closest('[data-county]');
      if (countyBtn) return selectCounty(countyBtn.dataset.county || null);
      const libBtn = event.target.closest('[data-lib]');
      if (libBtn) {
        const marker = pinById.get(libBtn.dataset.lib);
        map.setView(marker.getLatLng(), 14);
        marker.openPopup();
      }
    });
  }

  applyFilters();
}

// ---- FAQ page ----

function highlight(text, term) {
  const safe = escapeHtml(text);
  if (!term) return safe;
  const pattern = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}

async function renderFAQPage() {
  const container = document.getElementById('faqList');
  if (!container) return;
  const searchInput = document.getElementById('faqSearch');
  const chipsEl = document.getElementById('faqCategories');
  const askForm = document.getElementById('faqAsk');

  askForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = document.getElementById('faqAskInput').value.trim();
    if (q) location.href = `chatbot.html?q=${encodeURIComponent(q)}`;
  });

  container.innerHTML = '<div class="loading">Loading…</div>';
  let faqs;
  try {
    ({ faqs } = await api.content());
  } catch {
    showError(container, 'FAQs could not be loaded.');
    return;
  }

  const categories = [...new Set(faqs.map((f) => f.category || 'General'))];
  let activeCategory = '';
  chipsEl.innerHTML = ['', ...categories].map((c) => `<button type="button" data-category="${escapeHtml(c)}" class="${c === '' ? 'active' : ''}">${escapeHtml(c || 'All')}</button>`).join('');

  const render = () => {
    const term = searchInput.value.trim();
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = faqs.filter((f) =>
      (!activeCategory || (f.category || 'General') === activeCategory)
      && words.every((w) => `${f.q} ${f.a} ${f.category}`.toLowerCase().includes(w))
    );

    if (!matches.length) {
      container.innerHTML = `<div class="empty-state">No questions match "${escapeHtml(term)}". <a href="chatbot.html?q=${encodeURIComponent(term)}">Ask the assistant instead →</a></div>`;
      return;
    }

    const groups = categories.map((c) => [c, matches.filter((f) => (f.category || 'General') === c)]).filter(([, list]) => list.length);
    container.innerHTML = groups.map(([category, list]) => `
      <h3 class="faq-group-title">${escapeHtml(category)}</h3>
      ${list.map((item) => `
        <details class="faq-item" id="${escapeHtml(item.id || '')}" ${term || location.hash === `#${item.id}` ? 'open' : ''}>
          <summary>${highlight(item.q, term)}</summary>
          <div class="faq-answer">
            <p>${highlight(item.a, term)}</p>
            <div class="faq-actions">
              <a href="chatbot.html?q=${encodeURIComponent(item.q)}">Ask the assistant about this</a>
              ${item.id ? `<button type="button" data-copy="${escapeHtml(item.id)}">Copy link</button>` : ''}
            </div>
          </div>
        </details>`).join('')}`).join('');
  };

  searchInput.addEventListener('input', render);
  chipsEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-category]');
    if (!chip) return;
    activeCategory = chip.dataset.category;
    chipsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === chip));
    render();
  });
  container.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const url = `${location.origin}${location.pathname}#${btn.dataset.copy}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Link copied';
    } catch {
      history.replaceState(null, '', `#${btn.dataset.copy}`);
      btn.textContent = 'Link is in the address bar';
    }
  });

  render();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
}

// ---- chatbot page ----

const CHAT_STORAGE_KEY = 'lightlibrary-chat';
const CHAT_SUGGESTIONS = [
  'Closest library to 27601',
  'Libraries with Wi-Fi and teen programs in Charlotte',
  'How do I get a library card?',
  'What free ebooks can I use?',
  'Libraries in Wake County'
];

// Bot replies are plain text: escape, turn "- " lines into a list, link URLs.
function formatReply(text) {
  const linkify = (s) => s.replace(/https?:\/\/[^\s<)]+[^\s<).,]/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  const lines = escapeHtml(text).split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const item = line.match(/^\s*[-•*]\s+(.*)/);
    if (item) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${linkify(item[1])}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += line.trim() ? `${linkify(line)}\n` : '\n';
    }
  }
  if (inList) html += '</ul>';
  return html.replace(/\n+<ul>/g, '<ul>').replace(/<\/ul>\n+/g, '</ul>').replace(/\n{3,}/g, '\n\n').trim();
}

function chatCardsHtml(libraries) {
  return libraries.map((lib) => {
    return `
      <div class="chat-card">
        ${lib.distanceMiles != null ? `<span class="dist">${lib.distanceMiles} mi</span>` : ''}
        <strong>${escapeHtml(lib.name)}</strong>
        <span class="muted">${escapeHtml(lib.address)}, ${escapeHtml(lib.city)}</span><br>
        ${escapeHtml(lib.phone)} · ${escapeHtml(lib.hours)}
        <div class="links">${libraryLinks(lib)}</div>
      </div>`;
  }).join('');
}

async function renderChatbot() {
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const chatArea = document.getElementById('chatArea');
  if (!form || !chatArea) return;

  const suggestionsEl = document.getElementById('chatSuggestions');
  const locateBtn = document.getElementById('chatLocate');
  const clearBtn = document.getElementById('chatClear');
  const modeEl = document.getElementById('chatMode');

  // transcript entries: { role: 'user'|'assistant'|'note', content, libraries? }
  let transcript = [];
  try { transcript = JSON.parse(sessionStorage.getItem(CHAT_STORAGE_KEY) || '[]'); } catch { transcript = []; }
  const save = () => { try { sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(transcript.slice(-40))); } catch { /* storage unavailable */ } };

  const scroll = () => { chatArea.scrollTop = chatArea.scrollHeight; };
  const addBubble = (entry) => {
    const bubble = document.createElement('div');
    if (entry.role === 'user') {
      bubble.className = 'chat-bubble user';
      bubble.textContent = entry.content;
    } else {
      bubble.className = `chat-bubble bot${entry.role === 'note' ? ' typing' : ''}`;
      bubble.innerHTML = formatReply(entry.content);
    }
    chatArea.appendChild(bubble);
    if (entry.libraries?.length) {
      const cards = document.createElement('div');
      cards.className = 'chat-cards';
      cards.innerHTML = chatCardsHtml(entry.libraries);
      chatArea.appendChild(cards);
    }
    scroll();
    return bubble;
  };

  const greet = () => addBubble({ role: 'assistant', content: 'Hello! I can find NC public libraries near you, tell you what services they offer, and answer questions about library cards and free online resources. Pick a suggestion below or type your own question.' });

  suggestionsEl.innerHTML = CHAT_SUGGESTIONS.map((s) => `<button type="button">${escapeHtml(s)}</button>`).join('');

  api.meta().then((meta) => {
    if (modeEl) modeEl.textContent = meta.ai ? 'AI answers powered by Claude, grounded in the NC library dataset.' : 'Basic mode: rule-based answers (no AI key configured).';
  }).catch(() => {});

  const send = async (message) => {
    if (!message) return;
    const history = transcript.filter((t) => t.role !== 'note').map(({ role, content }) => ({ role, content }));
    const userEntry = { role: 'user', content: message };
    transcript.push(userEntry);
    addBubble(userEntry);
    input.value = '';
    input.disabled = true;
    const typing = addBubble({ role: 'note', content: 'Looking that up…' });

    try {
      const { reply, libraries } = await api.chat(message, history);
      typing.remove();
      const entry = { role: 'assistant', content: reply, libraries: libraries || [] };
      transcript.push(entry);
      addBubble(entry);
    } catch {
      typing.remove();
      addBubble({ role: 'note', content: 'Sorry, I could not answer that right now. Please try again in a moment.' });
      transcript.pop();
    } finally {
      save();
      input.disabled = false;
      input.focus();
    }
  };

  if (transcript.length) transcript.forEach(addBubble); else greet();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value.trim());
  });
  suggestionsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (btn) send(btn.textContent);
  });
  clearBtn?.addEventListener('click', () => {
    transcript = [];
    save();
    APP_STATE.currentCoordinates = null;
    chatArea.innerHTML = '';
    greet();
  });
  locateBtn?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      addBubble({ role: 'note', content: 'Location is not available in this browser. Tell me your ZIP code instead.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        APP_STATE.currentCoordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
        send('What are the closest libraries to me?');
      },
      () => addBubble({ role: 'note', content: 'I could not access your location. Tell me your ZIP code instead.' }),
      { timeout: 10000 }
    );
  });

  const preset = new URLSearchParams(location.search).get('q');
  if (preset) {
    history.replaceState(null, '', location.pathname);
    send(preset.slice(0, 500));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderHomePage();
  renderSearchPage();
  renderStateMap();
  renderFAQPage();
  renderChatbot();
});
