// Thin, cached client for the Qloo Taste AI API (hackathon environment).
// Every tool the agent can call is built on these helpers.

const BASE = "https://hackathon.api.qloo.com";

export const DOMAINS = {
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  artist: "urn:entity:artist",
  book: "urn:entity:book",
  podcast: "urn:entity:podcast",
  video_game: "urn:entity:video_game",
  place: "urn:entity:place",
  destination: "urn:entity:destination",
  brand: "urn:entity:brand",
};

const DOMAIN_BY_URN = Object.fromEntries(Object.entries(DOMAINS).map(([k, v]) => [v, k]));

// Per-isolate memo so repeated demo runs stay fast (and under the Workers subrequest cap).
const memo = new Map();

// Small concurrency gate: Qloo's hackathon tier throttles bursts.
let active = 0;
const waiters = [];
const LIMIT = 6;
const acquire = () => (active < LIMIT ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => {
  const next = waiters.shift();
  if (next) next();
  else active--;
};

async function qloo(env, path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const url = `${BASE}${path}?${qs.toString()}`;
  if (memo.has(url)) return memo.get(url);

  let res, text;
  for (let attempt = 0; attempt < 3; attempt++) {
    await acquire();
    try {
      res = await fetch(url, { headers: { "X-Api-Key": env.QLOO_API_KEY, accept: "application/json" } });
      text = await res.text();
    } finally {
      release();
    }
    if (res.ok || (res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res.ok) throw new Error(`Qloo ${path} ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  memo.set(url, data);
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return data;
}

const short = (s, n = 220) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

export function slimEntity(e) {
  const p = e.properties || {};
  const domain = DOMAIN_BY_URN[e.subtype] || DOMAIN_BY_URN[(e.types || [])[0]] || (e.subtype || "").split(":").pop();
  return {
    id: e.entity_id,
    name: e.name,
    domain,
    year: p.release_year || p.publication_year || p.year || undefined,
    by: domain === "artist" || domain === "place" ? undefined : (Array.isArray(p.collaborators) ? p.collaborators.slice(0, 2).join(", ") : undefined) || (Array.isArray(p.authors) ? p.authors.slice(0, 2).join(", ") : p.author) || undefined,
    image: p.image?.url || e.image?.url || undefined,
    description: short(p.short_description || p.description || p.plot_summary || ""),
    address: p.address || undefined,
    affinity: e.query?.affinity != null ? Math.round(e.query.affinity * 100) / 100 : undefined,
    tags: (e.tags || [])
      .filter((t) => /genre|style|theme|mood|subgenre|audience/.test(t.type || t.subtype || "") && !/^(Place|Shopping|Restaurant)$/.test(t.name))
      .slice(0, 6)
      .map((t) => t.name),
    url: Array.isArray(p.websites) ? p.websites[0] : undefined,
  };
}

/** Resolve a free-text favourite to Qloo entities. */
const MEDIA_TYPES = ["movie", "tv_show", "artist", "book", "podcast"].map((d) => DOMAINS[d]);

export async function searchEntity(env, { query, domain, mediaFirst }) {
  const types = domain && DOMAINS[domain] ? DOMAINS[domain] : mediaFirst ? MEDIA_TYPES : undefined;
  const data = await qloo(env, "/search", { query, types, take: 4 });
  return (data.results || []).map((r) => {
    const p = r.properties || {};
    return {
      id: r.entity_id,
      name: r.name,
      domain: DOMAIN_BY_URN[(r.types || [])[0]] || (r.types || [])[0],
      year: p.release_year || p.publication_year || undefined,
      image: p.image?.url,
      popularity: r.popularity != null ? Math.round(r.popularity * 100) / 100 : undefined,
    };
  });
}

/** Compare two taste profiles: shared tags, and what is unique to each side. */
export async function compareTastes(env, { a_ids, b_ids, take = 10 }) {
  const data = await qloo(env, "/v2/insights/compare", {
    "a.signal.interests.entities": a_ids,
    "b.signal.interests.entities": b_ids,
    take,
  });
  const r = data.results || {};
  const tag = (t) => ({ id: t.tag_id || t.id, name: t.name, kind: (t.subtype || "").split(":")[2] || "tag", sub: (t.subtype || "").split(":").slice(2).join(":"), score: t.query?.score != null ? Math.round(t.query.score * 100) / 100 : undefined });
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((t) => {
      const k = t.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return {
    shared: dedupe((r.tags || []).map(tag)),
    only_a: dedupe((r.a || []).map(tag)),
    only_b: dedupe((r.b || []).map(tag)),
  };
}

/** Cross-domain recommendations from entity and/or tag signals. */
export async function recommend(env, { domain, entity_ids, tag_ids, location, place_tag_ids, take = 6, exclude_ids }) {
  const type = DOMAINS[domain];
  if (!type) throw new Error(`Unsupported domain ${domain}. Use one of ${Object.keys(DOMAINS).join(", ")}`);
  const params = {
    "filter.type": type,
    "signal.interests.entities": entity_ids,
    "signal.interests.tags": tag_ids,
    take: Math.min(Math.max(take, 1), 10) + (exclude_ids?.length || 0),
  };
  if (location && (domain === "place" || domain === "destination")) params["filter.location.query"] = location;
  if (place_tag_ids?.length && domain === "place") params["filter.tags"] = place_tag_ids;
  const data = await qloo(env, "/v2/insights", params);
  const ex = new Set([...(exclude_ids || []), ...(entity_ids || [])]);
  return (data.results?.entities || []).filter((e) => !ex.has(e.entity_id)).slice(0, take).map(slimEntity);
}

/** Look up valid Qloo tag ids by keyword (genres, cuisines, moods…). */
export async function searchTags(env, { query, domain }) {
  const data = await qloo(env, "/v2/tags", { "filter.query": query, "filter.parents.types": domain ? DOMAINS[domain] : undefined, take: 6 });
  return (data.results?.tags || []).map((t) => ({ id: t.id, name: t.name, kind: (t.type || "").split(":")[2] }));
}

/** Full entity records by id (used to enrich the final plan). */
export async function getEntities(env, ids) {
  if (!ids.length) return [];
  const data = await qloo(env, "/entities", { entity_ids: ids });
  return (data.results || []).map(slimEntity);
}
