import Anthropic from '@anthropic-ai/sdk';
import { RESOURCE_LABELS, resolveOrigin, resourcesFromText, searchLibraries } from './libraries.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

let client = null;
export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function describe(lib) {
  const where = lib.distanceMiles != null ? ` (${lib.distanceMiles} mi)` : '';
  const unverified = lib.unverifiedResources || [];
  const tags = lib.resources.map((r) => (RESOURCE_LABELS[r] || r) + (unverified.includes(r) ? ' (not reported, likely available)' : '')).join(', ');
  return `- ${lib.name}${where} | ${lib.system} | ${lib.address}, ${lib.city} NC ${lib.zip} | phone ${lib.phone} | ${lib.hours} | services: ${tags} | website ${lib.url}`;
}

/** Pull the libraries relevant to a question so the model answers from real records. */
const ZIP_RE = /\b2[78]\d{3}\b/;

function findPlace(data, text) {
  const lower = text.toLowerCase();
  const has = (name) => new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower);
  const county = data.libraries.find((lib) => has(`${lib.county} county`));
  if (county) return county.county;
  const city = data.libraries.find((lib) => lib.city.length > 3 && has(lib.city));
  return city ? city.city : '';
}

/**
 * Pull the libraries relevant to a question so the model answers from real records.
 * A ZIP or place from an earlier user turn is reused when the new message has none,
 * so follow-ups like "which of those has Wi-Fi?" keep their location.
 */
function gatherContext(data, message, history, location) {
  const earlier = history.filter((m) => m.role === 'user').map((m) => String(m.content)).reverse();
  const zip = (message.match(ZIP_RE) || [])[0]
    || (!findPlace(data, message) && earlier.map((t) => (t.match(ZIP_RE) || [])[0]).find(Boolean));
  const origin = resolveOrigin(data, { zip, lat: location?.lat, lng: location?.lng });

  let resources = resourcesFromText(message);
  let query = '';
  if (!origin) query = findPlace(data, message) || earlier.map((t) => findPlace(data, t)).find(Boolean) || '';

  let { results } = searchLibraries(data, { origin, resources, query, limit: 8 });
  // Too narrow (e.g. three filters at once): drop the filters rather than return nothing.
  if (!results.length && resources.length && (origin || query)) {
    resources = [];
    results = searchLibraries(data, { origin, query, limit: 8 }).results;
  }
  return { origin, resources, query, results };
}

function cardFields(lib) {
  return {
    id: lib.id, name: lib.name, system: lib.system, address: lib.address, city: lib.city,
    zip: lib.zip, phone: lib.phone, hours: lib.hours, url: lib.url, distanceMiles: lib.distanceMiles
  };
}

function ruleBasedReply(data, message, ctx) {
  const text = message.toLowerCase();
  const { origin, resources, results } = ctx;

  if (/workshop|event|program|class/.test(text) && !origin) {
    return 'Live workshop calendars are not connected yet. The workshops on the home page are sample listings, so check your library\'s website for current events. Tell me your ZIP code and I can find your nearest branch and its website.';
  }
  if (/digital|ebook|e-book|online|database|free/.test(text) && !origin && !ctx.query) {
    return 'Free digital resources: ' + data.digitalResources.map((r) => `${r.title} (${r.url})${r.needsCard ? ' with a library card' : ''}`).join('; ') + '.';
  }
  if (results.length && (origin || ctx.query)) {
    const best = results[0];
    const wanted = resources.length ? ` with ${resources.map((r) => RESOURCE_LABELS[r].toLowerCase()).join(' and ')}` : '';
    const lead = origin
      ? `The closest library${wanted} to ${origin.label} is ${best.name} (${best.system}), about ${best.distanceMiles} miles away.`
      : `Libraries${wanted} in ${ctx.query}: ${best.name} (${best.system}).`;
    const others = results.slice(1, 3).map((l) => l.name + (l.distanceMiles != null ? ` (${l.distanceMiles} mi)` : '')).join(', ');
    return `${lead} Address: ${best.address}, ${best.city} NC ${best.zip}. Phone: ${best.phone}. ${others ? `Other options nearby: ${others}.` : ''}`.trim();
  }
  if (origin === null && /near|close|closest|nearest/.test(text)) {
    return 'Tell me your NC ZIP code (for example "closest library to 27601") or a city name and I will find the nearest branches.';
  }
  return `I can find NC public libraries by ZIP code or city, and filter by ${Object.values(RESOURCE_LABELS).join(', ').toLowerCase()}. Try "library with Wi-Fi near 28202" or "libraries in Asheville".`;
}

const SYSTEM_PROMPT = `You are the LightLibrary assistant for North Carolina public libraries.
Answer using the library records and site content provided in each message. Give branch names, distances, addresses and phone numbers from those records.
If the records do not contain something (for example specific event times, GED classes, or language services), say that the dataset does not list it and suggest contacting the library or visiting its website. Do not invent services, hours or events.
Workshops in the site content are sample listings, not real events.
If the user has not given a location and needs the nearest branch, ask for their ZIP code or city.
Keep answers short and plain: a few sentences or a short list using "- " bullets. No markdown headings, bold or tables. Write URLs in full.
The page shows cards for the top matching libraries under your reply, so you do not need to repeat every address; focus on answering the question.`;

export async function chatReply(data, message, history = [], location = null) {
  const ctx = gatherContext(data, message, history, location);
  const libraries = (ctx.origin || ctx.query) ? ctx.results.slice(0, 3).map(cardFields) : [];

  if (!aiEnabled()) {
    return { reply: ruleBasedReply(data, message, ctx), mode: 'rules', libraries };
  }

  const contextBlock = [
    ctx.origin ? `User location: ${ctx.origin.label}` : 'User location: unknown',
    ctx.resources.length ? `Requested services: ${ctx.resources.join(', ')}` : '',
    `Matching library records (${ctx.results.length}):`,
    ctx.results.map(describe).join('\n') || '(none matched)',
    'Free digital resources: ' + data.digitalResources.map((r) => `${r.title} - ${r.description} ${r.url}`).join(' | '),
    'Sample workshops (not real events): ' + data.workshops.map((w) => `${w.title}, ${w.city}, ${w.date}`).join(' | '),
    'Site FAQ:\n' + data.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n')
  ].filter(Boolean).join('\n');

  const messages = [
    ...history.slice(-8).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content) })),
    { role: 'user', content: `<library_data>\n${contextBlock}\n</library_data>\n\n${message}` }
  ];

  try {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages
    });
    if (response.stop_reason === 'refusal') {
      return { reply: ruleBasedReply(data, message, ctx), mode: 'rules', libraries };
    }
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { reply: reply || ruleBasedReply(data, message, ctx), mode: 'ai', libraries };
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}: ${error.message}`);
    } else {
      console.error('Chat error:', error);
    }
    return { reply: ruleBasedReply(data, message, ctx), mode: 'rules', libraries };
  }
}
