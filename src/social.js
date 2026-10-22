// Social layer: accounts, Taste ID cards, Taste Radar (matching), waves (blind match) and Taste Duels.
// Storage: Cloudflare D1 (binding DB). Every taste signal comes from Qloo.

import { searchEntity, recommend, compareTastes, qlooTags } from "./qloo.js";

const MODEL = "@cf/openai/gpt-oss-120b";
const FALLBACK = "@cf/meta/llama-4-scout-17b-16e-instruct";
const DAY = 86400;
const COLORS = ["#e0613f", "#2f6fb3", "#7a4f8f", "#2f8f6b", "#c08a1e", "#b8456b", "#3d5a80", "#8a5a44"];

// ---------- helpers ----------
const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const bad = (msg, status = 400) => json({ error: msg }, status);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
const norm = (s) => String(s || "").toLowerCase().trim();

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function cookie(token, maxAge) {
  return `tb_s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function currentUser(env, request) {
  const m = /(?:^|;\s*)tb_s=([a-f0-9]{40})/.exec(request.headers.get("cookie") || "");
  if (!m) return null;
  return env.DB.prepare("SELECT u.id, u.handle, u.demo FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?").bind(m[1], now()).first();
}
async function startSession(env, userId) {
  const token = randHex(20);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)").bind(token, userId, now() + 30 * DAY).run();
  return token;
}

function parseProfile(row) {
  if (!row) return null;
  const p = { ...row };
  for (const k of ["items", "entities", "tags"]) {
    try {
      p[k] = JSON.parse(row[k] || "[]");
    } catch {
      p[k] = [];
    }
  }
  return p;
}
const PROFILE_SQL = "SELECT u.id, u.handle, u.demo, p.display, p.city, p.bio, p.color, p.entities, p.tags, p.archetype, p.tagline, p.updated FROM users u LEFT JOIN profiles p ON p.user_id = u.id";

// Public shape of a card. `blind` hides identity (used on the radar until both people wave).
function publicCard(p, { blind = false } = {}) {
  const ents = (p.entities || []).map(({ id, name, domain, image, year }) => ({ id, name, domain, image, year }));
  const tags = displayTags((p.tags || []).filter((t) => t.ch !== "e"), 8);
  const all = p.tags || [];
  const next = [...all.filter((t) => t.ch === "e" && t.kind === "movie").slice(0, 3), ...all.filter((t) => t.ch === "e" && t.kind === "artist").slice(0, 2)].map(({ id, name, kind, image, year }) => ({ id, name, domain: kind, image, year }));
  const music = topTags(all.filter((t) => t.ch === "m"), 4);
  const story = topTags(all.filter((t) => t.ch !== "e" && t.ch !== "m"), 40);
  const group = (re) => story.filter((t) => re.test(t.kind || "")).slice(0, 4).map((t) => t.name);
  const dna = { style: group(/^style/), genre: group(/^genre:media/), archetype: group(/^archetype/), character: group(/^character/), theme: group(/^theme/), music: music.map((t) => t.name) };
  const card = { archetype: p.archetype || "", tagline: p.tagline || "", color: p.color || COLORS[p.id % COLORS.length], favorites: ents, tags, next, dna, demo: !!p.demo, city: p.city || "" };
  if (blind) return { ...card, uid: p.id, favorites: ents.slice(0, 4) };
  return { ...card, uid: p.id, handle: p.handle, display: p.display || p.handle, bio: p.bio || "", complete: ents.length >= 3 };
}

// ---------- taste vectors ----------
// Tag kinds that say something about taste (not formats or trivia).
const DULL = new Set(["african american", "lgbt", "race", "feminism", "contemporary", "fiction", "marvel", "paranormal", "indie", "rock", "pop", "classics", "novels", "literature", "fiction", "soundtrack", "musicals", "showtunes", "broadway", "musical theatre", "country", "bass", "+young adult"]);

function topTags(tags, n) {
  const seen = new Set();
  return tags
    .filter((t) => {
      const k = norm(t.name);
      if (DULL.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, n)
    .map((t) => ({ id: t.id, name: t.name.trim(), kind: t.kind }));
}

/** Card tags: mix kinds so music genres don't crowd out style and story tags. */
function displayTags(tags, n) {
  const order = ["style:qloo", "genre:media", "archetype:qloo", "genre:music", "character:qloo", "theme:qloo"];
  const buckets = order.map((k) => topTags(tags.filter((t) => t.kind === k), n));
  const out = [];
  for (let i = 0; out.length < n && i < n; i++) for (const b of buckets) if (b[i] && out.length < n) out.push(b[i]);
  return out;
}

const STORY_TYPES = ["urn:tag:style:qloo", "urn:tag:genre:media", "urn:tag:archetype:qloo", "urn:tag:character:qloo", "urn:tag:theme:qloo"];
const rankW = (i) => Math.round((1 / Math.sqrt(i + 1)) * 1000) / 1000;

/**
 * A person's taste fingerprint, all from Qloo, in three channels:
 *  t = story & style tags, m = music genres, e = what Qloo would recommend them next (films + artists).
 * Two people who'd be recommended the same next things genuinely share taste, even with different favorites.
 */
async function tasteVector(env, ids) {
  const [story, music, films, artists] = await Promise.all([
    qlooTags(env, { entity_ids: ids, types: STORY_TYPES, take: 40 }).catch(() => []),
    qlooTags(env, { entity_ids: ids, types: ["urn:tag:genre:music"], take: 15 }).catch(() => []),
    recommend(env, { domain: "movie", entity_ids: ids, take: 40 }).catch(() => []),
    recommend(env, { domain: "artist", entity_ids: ids, take: 30 }).catch(() => []),
  ]);
  const tag = (ch) => (t, i) => ({ id: t.id, name: t.name.trim(), kind: t.kind, ch, w: rankW(i) });
  const ent = (e, i) => ({ id: e.id, name: e.name, kind: e.domain, ch: "e", w: rankW(i), image: e.image, year: e.year });
  return [...story.map(tag("t")), ...music.map(tag("m")), ...films.map(ent), ...artists.map(ent)];
}

const CHANNEL_WEIGHT = { t: 0.4, m: 0.15, e: 0.45 };
function cosine(a, b) {
  const mb = new Map(b.map((t) => [t.id, t]));
  let dot = 0, na = 0, nb = 0;
  const shared = [];
  for (const t of a) {
    na += t.w * t.w;
    const o = mb.get(t.id);
    if (o) { dot += t.w * o.w; shared.push({ ...t, s: t.w * o.w }); }
  }
  for (const t of b) nb += t.w * t.w;
  shared.sort((x, y) => y.s - x.s);
  return { cos: na && nb ? dot / Math.sqrt(na * nb) : 0, shared };
}

/** Similarity of two fingerprints, plus the shared tags and shared next-picks that drive it. */
export function similarity(a, b, favA = [], favB = []) {
  a = a || []; b = b || [];
  let total = 0, wsum = 0;
  const parts = {};
  for (const ch of ["t", "m", "e"]) {
    const A = a.filter((x) => (x.ch || "t") === ch), B = b.filter((x) => (x.ch || "t") === ch);
    if (!A.length || !B.length) continue;
    parts[ch] = cosine(A, B);
    total += CHANNEL_WEIGHT[ch] * parts[ch].cos;
    wsum += CHANNEL_WEIGHT[ch];
  }
  const favIds = new Set(favB.map((e) => e.id));
  const sameFavs = favA.filter((e) => favIds.has(e.id));
  // Loving the very same title is the strongest signal of all.
  const cos = Math.min(1, (wsum ? total / wsum : 0) + 0.06 * sameFavs.length);
  const score = Math.max(1, Math.min(99, Math.round(100 * Math.pow(cos, 0.6))));
  const tags = [...(parts.t?.shared || []).slice(0, 4), ...(parts.m?.shared || []).slice(0, 1)];
  const picks = (parts.e?.shared || []).slice(0, 3).map(({ id, name, kind, image, year }) => ({ id, name, domain: kind, image, year }));
  return { score, cos: Math.round(cos * 1000) / 1000, shared: topTags(tags, 5), picks, both_love: sameFavs.map((e) => e.name) };
}

// ---------- LLM helpers ----------
async function llmJSON(env, system, user, maxTokens = 600) {
  for (const model of [MODEL, FALLBACK]) {
    try {
      const out = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.7 });
      const text = out?.choices?.[0]?.message?.content || out?.response || "";
      const m = /\{[\s\S]*\}/.exec(typeof text === "string" ? text : JSON.stringify(text));
      if (m) return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

async function nameArchetype(env, entities, tags) {
  const out = await llmJSON(
    env,
    "You write taste personas for a social app. Return only JSON: {\"archetype\": string, \"tagline\": string}. archetype: 2-4 words, Title Case, evocative and specific to this person's tags (like 'Midnight Sci-Fi Romantic' or 'Cozy Mystery Maximalist'); never generic. tagline: one playful second-person sentence under 16 words that names one of their favorites. Banned words: perfect, ultimate, journey, vibes, delve, tapestry, eclectic.",
    `Favorites: ${entities.map((e) => `${e.name} (${e.domain})`).join("; ")}\nTop Qloo taste tags: ${topTags(tags, 12).map((t) => t.name).join(", ")}`
  );
  return { archetype: String(out?.archetype || "Curious Culture Hound").slice(0, 40), tagline: String(out?.tagline || "").slice(0, 140) };
}

// ---------- route handlers ----------
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

async function signup(env, request) {
  const b = await body(request);
  const handle = norm(b.handle);
  const password = String(b.password || "");
  if (!HANDLE_RE.test(handle)) return bad("Username: 3-20 lowercase letters, numbers or _.");
  if (password.length < 6) return bad("Password needs at least 6 characters.");
  if (await env.DB.prepare("SELECT 1 FROM users WHERE handle = ?").bind(handle).first()) return bad("That username is taken.", 409);
  const salt = randHex(12);
  const hash = await hashPassword(password, salt);
  const r = await env.DB.prepare("INSERT INTO users (handle, pass_hash, salt, created) VALUES (?, ?, ?, ?)").bind(handle, hash, salt, now()).run();
  const id = r.meta.last_row_id;
  await env.DB.prepare("INSERT INTO profiles (user_id, display, color, entities, tags, updated) VALUES (?, ?, ?, '[]', '[]', ?)").bind(id, String(b.display || handle).slice(0, 30), COLORS[id % COLORS.length], now()).run();
  const token = await startSession(env, id);
  return json({ ok: true, handle }, 200, { "set-cookie": cookie(token, 30 * DAY) });
}

async function login(env, request) {
  const b = await body(request);
  const u = await env.DB.prepare("SELECT id, handle, pass_hash, salt FROM users WHERE handle = ?").bind(norm(b.handle)).first();
  if (!u || !safeEqual(await hashPassword(String(b.password || ""), u.salt), u.pass_hash)) return bad("Wrong username or password.", 401);
  const token = await startSession(env, u.id);
  return json({ ok: true, handle: u.handle }, 200, { "set-cookie": cookie(token, 30 * DAY) });
}

async function logout(env, request) {
  const m = /(?:^|;\s*)tb_s=([a-f0-9]{40})/.exec(request.headers.get("cookie") || "");
  if (m) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(m[1]).run();
  return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
}

async function loadProfile(env, where, val) {
  return parseProfile(await env.DB.prepare(`${PROFILE_SQL} WHERE ${where} = ?`).bind(val).first());
}

async function me(env, user) {
  const p = await loadProfile(env, "u.id", user.id);
  return json({ user: { handle: user.handle, uid: user.id }, card: publicCard(p) });
}

async function saveProfile(env, request, user) {
  const b = await body(request);
  const seen = new Set();
  const entities = (Array.isArray(b.favorites) ? b.favorites : [])
    .filter((e) => e && typeof e.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(e.id) && !seen.has(e.id) && seen.add(e.id))
    .slice(0, 10)
    .map((e) => ({ id: e.id, name: String(e.name || "").slice(0, 80), domain: String(e.domain || "").slice(0, 20), image: typeof e.image === "string" && e.image.startsWith("https://") ? e.image : undefined, year: e.year || undefined }));
  const old = await loadProfile(env, "u.id", user.id);
  const sameFavs = old.entities.map((e) => e.id).join() === entities.map((e) => e.id).join();
  let { tags, archetype, tagline } = old;
  if (!sameFavs || !archetype || b.refresh) {
    if (entities.length >= 1) {
      tags = await tasteVector(env, entities.map((e) => e.id));
      ({ archetype, tagline } = b.refresh && archetype && sameFavs && !b.rename ? { archetype, tagline } : await nameArchetype(env, entities, tags.filter((t) => t.ch !== "e")));
    } else {
      tags = [];
      archetype = tagline = "";
    }
  }
  await env.DB.prepare("UPDATE profiles SET display = ?, city = ?, bio = ?, entities = ?, tags = ?, archetype = ?, tagline = ?, updated = ? WHERE user_id = ?")
    .bind(String(b.display || user.handle).slice(0, 30), String(b.city || "").slice(0, 60), String(b.bio || "").slice(0, 160), JSON.stringify(entities), JSON.stringify(tags || []), archetype || "", tagline || "", now(), user.id)
    .run();
  return me(env, user);
}

async function getCard(env, handle, user) {
  const p = await loadProfile(env, "u.handle", norm(handle));
  if (!p) return bad("No one by that name.", 404);
  const out = { card: publicCard(p) };
  if (user && user.id !== p.id) {
    const mine = await loadProfile(env, "u.id", user.id);
    if (mine.tags.length && p.tags.length) out.match = similarity(mine.tags, p.tags, mine.entities, p.entities);
  }
  return json(out);
}

async function allProfiles(env) {
  const { results } = await env.DB.prepare(`${PROFILE_SQL} WHERE p.archetype IS NOT NULL AND p.archetype != ''`).all();
  return results.map(parseProfile);
}

async function waveState(env, me_id) {
  const { results } = await env.DB.prepare("SELECT from_id, to_id FROM waves WHERE from_id = ? OR to_id = ?").bind(me_id, me_id).all();
  const sent = new Set(), got = new Set();
  for (const r of results) r.from_id === me_id ? sent.add(r.to_id) : got.add(r.from_id);
  return { sent, got };
}

async function radar(env, user) {
  const mine = await loadProfile(env, "u.id", user.id);
  if ((mine.entities || []).length < 3) return json({ needsCard: true, people: [] });
  const [everyone, waves] = await Promise.all([allProfiles(env), waveState(env, user.id)]);
  const people = everyone
    .filter((p) => p.id !== user.id && p.entities.length >= 3)
    .map((p) => {
      const m = similarity(mine.tags, p.tags, mine.entities, p.entities);
      const mutual = waves.sent.has(p.id) && waves.got.has(p.id);
      return { ...publicCard(p, { blind: !mutual }), match: m.score, shared: m.shared, waved: waves.sent.has(p.id), wavedYou: waves.got.has(p.id) && !mutual, mutual };
    })
    .sort((a, b) => b.match - a.match)
    .slice(0, 24);
  return json({ people });
}

async function wave(env, user, uid) {
  const target = await env.DB.prepare("SELECT id, demo FROM users WHERE id = ?").bind(uid).first();
  if (!target || target.id === user.id) return bad("Can't wave at that card.");
  await env.DB.prepare("INSERT OR IGNORE INTO waves (from_id, to_id, created) VALUES (?, ?, ?)").bind(user.id, uid, now()).run();
  // Demo personas are friendly: they always wave back, so the flow can be tried end to end.
  if (target.demo) await env.DB.prepare("INSERT OR IGNORE INTO waves (from_id, to_id, created) VALUES (?, ?, ?)").bind(uid, user.id, now()).run();
  const w = await waveState(env, user.id);
  return json({ ok: true, mutual: w.got.has(uid) });
}

/** Revealed match: who they are, why you fit (Qloo compare), one thing to try together, and an AI opener. */
async function matchDetail(env, user, uid) {
  const w = await waveState(env, user.id);
  if (!(w.sent.has(uid) && w.got.has(uid))) return bad("This card reveals once you both wave.", 403);
  const key = `ice:${Math.min(user.id, uid)}:${Math.max(user.id, uid)}`;
  const [mine, them] = await Promise.all([loadProfile(env, "u.id", user.id), loadProfile(env, "u.id", uid)]);
  const cached = await env.DB.prepare("SELECT plan FROM bridges WHERE key = ?").bind(key).first();
  let extra;
  if (cached) extra = JSON.parse(cached.plan);
  else {
    const aIds = mine.entities.map((e) => e.id), bIds = them.entities.map((e) => e.id);
    const [cmp, joint] = await Promise.all([
      compareTastes(env, { a_ids: aIds, b_ids: bIds, take: 20 }).catch(() => ({ shared: [] })),
      recommend(env, { domain: "movie", entity_ids: [...aIds, ...bIds], take: 3, exclude_ids: [...aIds, ...bIds] }).catch(() => []),
    ]);
    const shared = (cmp.shared || []).filter((t) => /style|genre:media|theme|archetype|character|keyword:qloo/.test(t.sub || "")).slice(0, 6);
    const together = joint[0] || null;
    const ai = await llmJSON(
      env,
      "You write first messages for two people matched on a taste-based social app. Return only JSON: {\"opener\": string, \"why\": string}. opener: one friendly, specific first message (under 30 words) person A could send B, referencing something B loves and a shared taste. why: one sentence addressed to both of them, starting with 'You both', on why their tastes click, naming 1-2 shared tags. No pickup lines. Banned: perfect, ultimate, journey, vibes, delve, tapestry.",
      `A loves: ${mine.entities.map((e) => e.name).join(", ")}\nB loves: ${them.entities.map((e) => e.name).join(", ")}\nShared Qloo taste tags: ${shared.map((t) => t.name).join(", ") || similarity(mine.tags, them.tags, mine.entities, them.entities).shared.map((t) => t.name).join(", ")}${together ? `\nQloo says both would enjoy: ${together.name}` : ""}`
    );
    extra = { shared, together, opener: ai?.opener || "", why: ai?.why || "" };
    await env.DB.prepare("INSERT OR REPLACE INTO bridges (key, plan, created) VALUES (?, ?, ?)").bind(key, JSON.stringify(extra), now()).run();
  }
  return json({ card: publicCard(them), match: similarity(mine.tags, them.tags, mine.entities, them.entities), ...extra });
}

// ---------- Taste Duel ----------
// "How well do you know @them?" Five rounds, all scored against ground truth:
//  - "pick": which of three is really on their card? (decoys are Qloo recommendations from their own taste, so it's hard)
//  - "predict": which of two would they enjoy more? (truth = rank in Qloo's list for their taste)
const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const slim = (e) => ({ id: e.id, name: e.name, domain: e.domain, image: e.image, year: e.year });

async function createDuel(env, request, user) {
  const b = await body(request);
  const them = await loadProfile(env, "u.handle", norm(b.handle));
  if (!them || them.id === user.id) return bad("Pick someone else's card.");
  if (them.entities.length < 3) return bad("They need at least 3 favorites on their card first.");
  const mine = await loadProfile(env, "u.id", user.id);
  const theirIds = them.entities.map((e) => e.id);
  const real = shuffle(them.entities).slice(0, 3);
  const rounds = [];
  await Promise.all(
    real.map(async (fav) => {
      const decoys = (await recommend(env, { domain: fav.domain, entity_ids: theirIds, take: 8, exclude_ids: theirIds }).catch(() => [])).filter((d) => norm(d.name) !== norm(fav.name));
      const two = shuffle(decoys.slice(0, 6)).slice(0, 2);
      if (two.length === 2) rounds.push({ kind: "pick", options: shuffle([slim(fav), ...two.map(slim)]), answer: fav.id });
    })
  );
  const used = new Set(rounds.flatMap((r) => r.options.map((o) => o.id)));
  // Prediction rounds: one item high in their Qloo list vs one from far down it (or from your own taste).
  const myIds = (mine.entities || []).map((e) => e.id);
  for (const domain of shuffle(["movie", "artist", "book", "tv_show"]).slice(0, 2)) {
    const [theirs, yours] = await Promise.all([
      recommend(env, { domain, entity_ids: theirIds, take: 30, exclude_ids: theirIds }).catch(() => []),
      myIds.length ? recommend(env, { domain, entity_ids: myIds, take: 15, exclude_ids: [...theirIds, ...myIds] }).catch(() => []) : Promise.resolve([]),
    ]);
    const fresh = theirs.filter((e) => !used.has(e.id));
    if (fresh.length < 5) continue;
    const top = fresh[Math.floor(Math.random() * 3)];
    const theirSet = new Set(theirs.map((e) => e.id));
    const low = yours.find((e) => !theirSet.has(e.id) && !used.has(e.id)) || fresh[fresh.length - 1];
    used.add(top.id); used.add(low.id);
    rounds.push({ kind: "predict", options: shuffle([slim(top), slim(low)]), answer: top.id, domain });
  }
  if (rounds.length < 3) return bad("Qloo didn't return enough to build a duel for this card. Try another person.", 502);
  const id = randHex(8);
  await env.DB.prepare("INSERT INTO duels (id, creator_id, target_id, rounds, created) VALUES (?, ?, ?, ?, ?)").bind(id, user.id, them.id, JSON.stringify(shuffle(rounds).slice(0, 5)), now()).run();
  return json({ id });
}

async function getDuel(env, id, user) {
  const d = await env.DB.prepare("SELECT d.*, c.handle AS creator, t.handle AS target, tp.display AS target_display FROM duels d JOIN users c ON c.id = d.creator_id JOIN users t ON t.id = d.target_id LEFT JOIN profiles tp ON tp.user_id = t.id WHERE d.id = ?").bind(id).first();
  if (!d) return bad("Duel not found.", 404);
  const rounds = JSON.parse(d.rounds);
  const finished = d.score != null;
  return json({
    id,
    creator: d.creator,
    target: d.target,
    target_display: d.target_display || d.target,
    mine: user && user.id === d.creator_id,
    finished,
    score: d.score,
    answers: finished ? JSON.parse(d.answers || "[]") : undefined,
    rounds: rounds.map((r) => ({ kind: r.kind, options: r.options, domain: r.domain, answer: finished ? r.answer : undefined })),
  });
}

async function answerDuel(env, request, id, user) {
  const d = await env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(id).first();
  if (!d) return bad("Duel not found.", 404);
  if (d.creator_id !== user.id) return bad("Only the person who started this duel can play it.", 403);
  if (d.score != null) return bad("Already played.");
  const b = await body(request);
  const rounds = JSON.parse(d.rounds);
  const answers = (Array.isArray(b.answers) ? b.answers : []).slice(0, rounds.length).map(String);
  const score = rounds.reduce((s, r, i) => s + (answers[i] === r.answer ? 1 : 0), 0);
  await env.DB.prepare("UPDATE duels SET answers = ?, score = ? WHERE id = ?").bind(JSON.stringify(answers), score, id).run();
  return getDuel(env, id, user);
}

async function duelsFor(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT d.id, d.score, d.rounds, d.created, c.handle AS creator, t.handle AS target FROM duels d JOIN users c ON c.id = d.creator_id JOIN users t ON t.id = d.target_id WHERE d.creator_id = ? OR d.target_id = ? ORDER BY d.created DESC LIMIT 20"
  ).bind(user.id, user.id).all();
  return json({ duels: results.map((r) => ({ id: r.id, creator: r.creator, target: r.target, score: r.score, total: JSON.parse(r.rounds).length })) });
}

const DISCOVER_DOMAINS = ["movie", "tv_show", "artist", "book", "podcast"];
/** Poster wall for the Taste ID studio: Qloo's most popular titles, or (once you've picked a few) what Qloo predicts you'd also pick. */
async function discover(env, url) {
  const domain = DISCOVER_DOMAINS.includes(url.searchParams.get("domain")) ? url.searchParams.get("domain") : "movie";
  const seeds = (url.searchParams.get("seeds") || "").split(",").filter((x) => /^[A-Za-z0-9-]{8,64}$/.test(x)).slice(0, 10);
  const exclude = (url.searchParams.get("exclude") || "").split(",").filter(Boolean).slice(0, 20);
  let items = [];
  if (seeds.length) items = await recommend(env, { domain, entity_ids: seeds, take: 18, exclude_ids: [...seeds, ...exclude] }).catch(() => []);
  const personal = items.length >= 6;
  if (!personal) items = await recommend(env, { domain, take: 18, popularity: 0.95, exclude_ids: exclude }).catch(() => []);
  return json({ domain, personal, items: items.map(({ id, name, domain, image, year, tags }) => ({ id, name, domain, image, year, tags: (tags || []).slice(0, 2) })) });
}

async function search(env, url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  if (q.length < 2) return json({ results: [] });
  const media = await searchEntity(env, { query: q, mediaFirst: true }).catch(() => []);
  return json({ results: media.slice(0, 6) });
}

/** Entities for a bridge run between two saved cards. */
export async function bridgeInput(env, aHandle, bHandle) {
  const [a, b] = await Promise.all([loadProfile(env, "u.handle", norm(aHandle)), loadProfile(env, "u.handle", norm(bHandle))]);
  if (!a || !b) return null;
  return { a_name: a.display || a.handle, b_name: b.display || b.handle, a_entities: a.entities, b_entities: b.entities, city: a.city || b.city || "" };
}

// ---------- router ----------
export async function handleSocial(request, env, url) {
  const p = url.pathname;
  const m = request.method;
  const user = await currentUser(env, request);
  const need = () => (user ? null : bad("Sign in first.", 401));
  let r;
  if (p === "/api/signup" && m === "POST") return signup(env, request);
  if (p === "/api/login" && m === "POST") return login(env, request);
  if (p === "/api/logout" && m === "POST") return logout(env, request);
  if (p === "/api/search") return search(env, url);
  if (p === "/api/discover") return discover(env, url);
  if (p === "/api/me" && m === "GET") return user ? me(env, user) : json({ user: null });
  if (p === "/api/profile" && m === "POST") return (r = need()) || saveProfile(env, request, user);
  if (p.startsWith("/api/card/")) return getCard(env, decodeURIComponent(p.slice(10)), user);
  if (p === "/api/radar") return (r = need()) || radar(env, user);
  if (p.startsWith("/api/wave/") && m === "POST") return (r = need()) || wave(env, user, Number(p.slice(10)));
  if (p.startsWith("/api/match/")) return (r = need()) || matchDetail(env, user, Number(p.slice(11)));
  if (p === "/api/duel" && m === "POST") return (r = need()) || createDuel(env, request, user);
  if (p === "/api/duels") return (r = need()) || duelsFor(env, user);
  const dm = /^\/api\/duel\/([a-f0-9]{16})(\/answer)?$/.exec(p);
  if (dm && !dm[2]) return getDuel(env, dm[1], user);
  if (dm && dm[2] && m === "POST") return (r = need()) || answerDuel(env, request, dm[1], user);
  return null;
}
