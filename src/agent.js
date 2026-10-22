// The TasteBridge agent.
//
// Two phases:
//  1. Gather (fast, parallel, deterministic): resolve each favorite to a Qloo entity, compare
//     the two taste profiles, and pull three recommendation lists per domain — one for each
//     person alone and one for both together. An item that ranks well for BOTH people
//     individually is real common ground, not just one person's taste winning.
//  2. Curate (LLM tool loop): the model reads the evidence, may call Qloo again
//     (recommend / search_tags) to fill a gap or honor a follow-up request, and finally
//     calls present_plan. It may only cite entity ids that Qloo actually returned.

import { searchEntity, compareTastes, recommend, searchTags, DOMAINS } from "./qloo.js";

const MODELS = ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-4-scout-17b-16e-instruct"];
const MAX_STEPS = 6;
const DOMAIN_LIST = Object.keys(DOMAINS);
const GATHER_DOMAINS = ["movie", "tv_show", "artist", "book", "podcast"];
// Places two people can actually go together (not landmarks): cafes, cocktail bars, bookshops, record stores.
const SHARED_PLACE_TAGS = [
  "urn:tag:genre:place:restaurant:cafe",
  "urn:tag:genre:place:restaurant:cocktail_bar",
  "urn:tag:genre:place:book_store",
  "urn:tag:genre:place:record_store",
];

// Tag kinds that describe taste (not trivia like formats, instruments, or countries).
const TASTE_KINDS = /^(style|genre|subgenre|theme|audience|plot|character|archetype|music|artist|characteristic|mood|backdrop)$/;
const BORING = new Set(["drama", "love", "family,", "family", "fiction", "novels", "adult", "audiobook", "hardcover", "paperback", "united states", "comedy", "rock", "vocals", "guitar", "drums", "piano", "bass guitar", "keyboards", "keyboard", "4/4 time"]);

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "recommend",
      description:
        "Ask Qloo for more recommendations in one domain, driven by entity ids and/or tag ids. Use to fill a gap or honor a request (e.g. a vibe from search_tags). For place, pass a city in location.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", enum: DOMAIN_LIST },
          entity_ids: { type: "array", items: { type: "string" } },
          tag_ids: { type: "array", items: { type: "string" }, description: "Qloo tag ids only (from the evidence or search_tags)" },
          location: { type: "string" },
          place_tag_ids: { type: "array", items: { type: "string" } },
          take: { type: "integer" },
        },
        required: ["domain"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tags",
      description: "Find valid Qloo tag ids by keyword, e.g. 'comedy', 'feel-good', 'cocktail bar', 'jazz'.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, domain: { type: "string", enum: DOMAIN_LIST } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_plan",
      description: "FINAL STEP. Present the common-ground plan. Every pick must be an entity id that Qloo returned. Call exactly once.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Evocative name for their shared taste, 2-5 words, no colon" },
          overlap: { type: "string", description: "2 sentences on what they genuinely share, naming shared Qloo tags and one favorite of each" },
          tension: { type: "string", description: "1-2 sentences on where their tastes pull apart, naming each side's distinct tags; warm, a little witty" },
          picks: {
            type: "array",
            description: "4-6 picks, at most one per domain",
            items: {
              type: "object",
              properties: {
                entity_id: { type: "string" },
                why: { type: "string", description: "One specific sentence: why it lands for both, referencing something each person listed" },
                bridge: { type: "string", enum: ["both", "a_to_b", "b_to_a"] },
              },
              required: ["entity_id", "why", "bridge"],
            },
          },
          opener: { type: "string", description: "One question they could ask each other tonight, drawn from the tension" },
        },
        required: ["title", "overlap", "tension", "picks", "opener"],
      },
    },
  },
];

const SYSTEM = `You are TasteBridge, an agent that finds real common ground between two people's tastes using Qloo's cultural taste graph.

You receive evidence gathered from Qloo: each person's resolved favorites, shared and distinct taste tags, and candidate recommendations per domain with a "fit" for each person (A rank / B rank in their personal Qloo lists; "both" means it ranks for both people individually, which is the strongest common ground).

Curate a plan:
- Prefer candidates marked fit=both. fit=A means it ranks in A's personal Qloo list (A will likely love it, but A has NOT listed it); argue why B would enjoy it too, via shared tags. fit=B is the reverse. Never call a candidate someone's "favorite": only the listed items are favorites.
- Refer to people by name; never use he/she/his/her.
- 4-6 picks, at most ONE per domain (film, series, music artist, book, podcast, and a place if a city was given). Avoid the most obvious blockbuster when a sharper option exists.
- Every claim must come from the evidence (tags, descriptions). Never invent titles or facts.
- If the evidence lacks something you need (or the people asked for a change), call recommend or search_tags first. You can call several tools at once.
- Then call present_plan exactly once.
- Style: specific, warm, plain English (or the people's language if they wrote in another). Banned words: perfect, ultimate, journey, vibes, delve, tapestry.`;

async function callModel(env, messages, emit, forcePlan) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const out = await env.AI.run(model, {
        messages,
        tools: forcePlan ? TOOLS.filter((t) => t.function.name === "present_plan") : TOOLS,
        max_tokens: 3000,
        temperature: 0.5,
      });
      const msg = out?.choices?.[0]?.message;
      if (msg) return msg;
      if (out?.tool_calls || out?.response) {
        return {
          role: "assistant",
          content: out.response || null,
          tool_calls: (out.tool_calls || []).map((t, i) => ({ id: `call_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
        };
      }
      throw new Error("empty model response");
    } catch (e) {
      lastErr = e;
      emit({ type: "note", text: `Model ${model.split("/").pop()} failed, using fallback` });
    }
  }
  throw lastErr;
}

const norm = (s) => s.toLowerCase().trim();

function tasteTags(list) {
  const seen = new Set();
  return list.filter((t) => {
    const k = norm(t.name);
    if (!TASTE_KINDS.test(t.kind) || BORING.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function safe(p, fallback = []) {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** Phase 1: gather evidence from Qloo, in parallel. */
async function gather(env, input, ctx, registry, emit) {
  // Resolve favorites.
  const resolveSide = (items, side) =>
    Promise.all(
      items.map(async (q) => {
        emit({ type: "step", tool: "search", label: `Looking up “${q}” in Qloo` });
        // Favorites are usually culture (films, shows, music, books, podcasts); fall back to anything.
        let res = await safe(searchEntity(env, { query: q, mediaFirst: true }));
        const close = (r) => r && norm(r.name).replace(/[^a-z0-9]/g, "").includes(norm(q).replace(/[^a-z0-9]/g, "").slice(0, 12));
        if (!close(res[0])) {
          const any = await safe(searchEntity(env, { query: q }));
          if (close(any[0]) || !res.length) res = any;
        }
        const best = res[0];
        if (best) {
          registry.set(best.id, best);
          emit({ type: "resolved", side, query: q, entity: best });
        } else emit({ type: "note", text: `No Qloo match for “${q}”` });
        return best;
      })
    );
  const preset = (ents, side) =>
    ents.map((e) => {
      registry.set(e.id, e);
      emit({ type: "resolved", side, query: e.name, entity: e });
      return e;
    });
  const [a, b] = input.a_entities
    ? [preset(input.a_entities, "a"), preset(input.b_entities, "b")]
    : await Promise.all([resolveSide(input.a_items, "a"), resolveSide(input.b_items, "b")]);
  const pick = (x) => x && { id: x.id, name: x.name, domain: x.domain };
  ctx.a = a.filter(Boolean).map(pick);
  ctx.b = b.filter(Boolean).map(pick);
  if (!ctx.a.length || !ctx.b.length) throw new Error("Couldn't find enough of those favorites in Qloo. Try more widely known titles.");
  const aIds = ctx.a.map((x) => x.id);
  const bIds = ctx.b.map((x) => x.id);
  const listed = new Set([...aIds, ...bIds]);
  const listedNames = new Set([...(input.a_items || []), ...(input.b_items || []), ...ctx.a.map((x) => x.name), ...ctx.b.map((x) => x.name)].map(norm));
  ctx.listedNames = [...listedNames];

  // Compare taste profiles. "Shared" = tags present in both distinct profiles + Qloo's own overlap tags.
  emit({ type: "step", tool: "compare", label: `Comparing ${ctx.a_name}'s and ${ctx.b_name}'s taste graphs` });
  const cmp = await compareTastes(env, { a_ids: aIds, b_ids: bIds, take: 50 });
  const aT = tasteTags(cmp.only_a);
  const bT = tasteTags(cmp.only_b);
  const bNames = new Set(bT.map((t) => norm(t.name)));
  const aNames = new Set(aT.map((t) => norm(t.name)));
  const both = tasteTags([...cmp.shared.filter((t) => !/genre:music|instrument|characteristic|region/.test(t.sub)), ...aT.filter((t) => bNames.has(norm(t.name)))]);
  const sharedNames = new Set(both.map((t) => norm(t.name)));
  ctx.shared = both.slice(0, 10);
  ctx.only_a = aT.filter((t) => !sharedNames.has(norm(t.name)) && !bNames.has(norm(t.name))).slice(0, 10);
  ctx.only_b = bT.filter((t) => !sharedNames.has(norm(t.name)) && !aNames.has(norm(t.name))).slice(0, 10);
  emit({ type: "compare", shared: ctx.shared, only_a: ctx.only_a, only_b: ctx.only_b, a: ctx.a, b: ctx.b });

  // Three lists per domain: A alone, B alone, both together.
  const domains = [...GATHER_DOMAINS];
  if (ctx.city) domains.push("place");
  const evidence = {};
  await Promise.all(
    domains.map(async (domain) => {
      emit({ type: "step", tool: "insights", label: `Asking Qloo for ${domain.replace("_", " ")}s: ${ctx.a_name} alone, ${ctx.b_name} alone, and both${domain === "place" ? ` in ${ctx.city}` : ""}` });
      const loc = domain === "place" ? ctx.city : undefined;
      const ptags = domain === "place" ? SHARED_PLACE_TAGS : undefined;
      const [la, lb, lab] = await Promise.all([
        safe(recommend(env, { domain, entity_ids: aIds, location: loc, place_tag_ids: ptags, take: 25 })),
        safe(recommend(env, { domain, entity_ids: bIds, location: loc, place_tag_ids: ptags, take: 25 })),
        safe(recommend(env, { domain, entity_ids: [...aIds, ...bIds], location: loc, place_tag_ids: ptags, take: 12 })),
      ]);
      const rankA = new Map(la.map((e, i) => [e.id, i + 1]));
      const rankB = new Map(lb.map((e, i) => [e.id, i + 1]));
      const pool = new Map();
      for (const e of [...lab, ...la.slice(0, 8), ...lb.slice(0, 8)]) if (!listed.has(e.id) && !listedNames.has(norm(e.name)) && !pool.has(e.id)) pool.set(e.id, e);
      const cands = [...pool.values()].map((e) => {
        const ra = rankA.get(e.id), rb = rankB.get(e.id);
        const fit = ra && rb ? "both" : ra ? "A" : rb ? "B" : "blend";
        const c = { ...e, a_rank: ra, b_rank: rb, fit };
        registry.set(e.id, c);
        return c;
      });
      // Strongest common ground first: ranks for both, then the blended list order.
      cands.sort((x, y) => (x.fit === "both" ? 0 : 1) - (y.fit === "both" ? 0 : 1) || ((x.a_rank || 30) + (x.b_rank || 30)) - ((y.a_rank || 30) + (y.b_rank || 30)));
      evidence[domain] = cands.slice(0, 9);
      emit({ type: "candidates", domain, items: evidence[domain].slice(0, 6).map(({ id, name, image, year, fit }) => ({ id, name, image, year, fit })) });
    })
  );
  return evidence;
}

function evidenceText(ctx, evidence) {
  const fmt = (e) =>
    `- id=${e.id} | ${e.name}${e.year ? ` (${e.year})` : ""}${e.by ? ` by ${e.by}` : ""} | fit=${e.fit}${e.a_rank ? ` A#${e.a_rank}` : ""}${e.b_rank ? ` B#${e.b_rank}` : ""} | tags: ${(e.tags || []).join(", ")}${e.address ? ` | ${e.address}` : ""} | ${(e.description || "").slice(0, 150)}`;
  return [
    `${ctx.a_name} (A) listed: ${ctx.a.map((x) => `${x.name} [${x.domain}]`).join("; ")}`,
    `${ctx.b_name} (B) listed: ${ctx.b.map((x) => `${x.name} [${x.domain}]`).join("; ")}`,
    `Shared taste tags: ${ctx.shared.map((t) => `${t.name} (${t.id})`).join(", ") || "few"}`,
    `Only ${ctx.a_name}: ${ctx.only_a.map((t) => t.name).join(", ")}`,
    `Only ${ctx.b_name}: ${ctx.only_b.map((t) => t.name).join(", ")}`,
    ctx.city ? `City: ${ctx.city}` : "No city given.",
    ...Object.entries(evidence).map(([d, list]) => `\n## ${d} candidates\n${list.map(fmt).join("\n")}`),
  ].join("\n");
}

/**
 * input: { a_name, b_name, a_items[], b_items[], city?, refine?, context? }
 * emit(event) streams progress to the browser.
 */
export async function runAgent(env, input, emit) {
  const registry = new Map();
  const ctx = input.context ? { ...input.context } : {};
  ctx.a_name = input.a_name || ctx.a_name || "A";
  ctx.b_name = input.b_name || ctx.b_name || "B";
  ctx.city = input.city || ctx.city || "";
  for (const e of ctx.entities || []) registry.set(e.id, e);
  delete ctx.entities;

  let evidence = ctx.evidence;
  if (!input.refine || !evidence) {
    evidence = await gather(env, input, ctx, registry, emit);
  } else {
    for (const list of Object.values(evidence)) for (const e of list) registry.set(e.id, e);
    emit({ type: "compare", shared: ctx.shared, only_a: ctx.only_a, only_b: ctx.only_b, a: ctx.a, b: ctx.b });
  }

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Evidence from Qloo:\n${evidenceText(ctx, evidence)}` },
  ];
  if (input.refine) {
    messages.push({
      role: "user",
      content: `You already suggested: ${(ctx.picked || []).map((id) => registry.get(id)?.name).filter(Boolean).join(", ")}. Don't repeat those.\nThey ask for a change: "${input.refine}". Fetch what you need from Qloo (search_tags then recommend with those tag ids and both people's entity ids), then present a fresh plan.`,
    });
  } else {
    messages.push({ role: "user", content: `Curate the common-ground plan for ${ctx.a_name} and ${ctx.b_name}.` });
  }

  const allIds = () => [...(ctx.a || []), ...(ctx.b || [])].map((x) => x.id);
  const handlers = {
    async recommend(args) {
      emit({ type: "step", tool: "insights", label: `Agent asks Qloo for more ${String(args.domain).replace("_", " ")}s${args.tag_ids?.length ? ` with ${args.tag_ids.length} tag signal(s)` : ""}${args.location ? ` in ${args.location}` : ""}` });
      const entity_ids = args.entity_ids?.length ? args.entity_ids : allIds();
      let res = await safe(recommend(env, { ...args, entity_ids, exclude_ids: [...allIds(), ...(ctx.picked || [])], take: args.take || 8 }), null);
      if (!res || !res.length) res = await safe(recommend(env, { domain: args.domain, entity_ids, location: args.location, tag_ids: args.tag_ids, exclude_ids: [...allIds(), ...(ctx.picked || [])], take: 8 }));
      res.forEach((e) => registry.set(e.id, { ...e, fit: "blend" }));
      emit({ type: "candidates", domain: args.domain, items: res.slice(0, 6).map(({ id, name, image, year }) => ({ id, name, image, year })) });
      return res.map(({ id, name, year, by, affinity, tags, description, address }) => ({ id, name, year, by, affinity, tags, description: (description || "").slice(0, 140), address }));
    },
    async search_tags(args) {
      emit({ type: "step", tool: "tags", label: `Agent looks up Qloo tags for “${args.query}”` });
      return searchTags(env, args);
    },
  };

  emit({ type: "step", tool: "agent", label: input.refine ? `Planning around “${input.refine}”` : "Weighing candidates that fit both of you" });
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await callModel(env, messages, emit, step === MAX_STEPS - 1);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      messages.push({ role: "assistant", content: msg.content || "" });
      messages.push({ role: "user", content: "Call present_plan now." });
      continue;
    }
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });

    const parsed = calls.map((c) => {
      let args = {};
      try {
        args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments || {};
      } catch {}
      return { id: c.id, name: c.function?.name, args };
    });

    const plan = parsed.find((c) => c.name === "present_plan");
    if (plan) {
      const listedNames = new Set(ctx.listedNames || []);
      const seenDomains = new Set();
      const picks = (plan.args.picks || [])
        .filter((p) => registry.has(p.entity_id) && !allIds().includes(p.entity_id) && !listedNames.has(norm(registry.get(p.entity_id).name)))
        .filter((p) => {
          const d = registry.get(p.entity_id).domain;
          if (seenDomains.has(d)) return false;
          seenDomains.add(d);
          return true;
        })
        .map((p) => {
          const entity = registry.get(p.entity_id);
          // The bridge label must match the evidence, not the model's guess.
          const bridge = entity.fit === "both" ? "both" : entity.fit === "A" ? "a_to_b" : entity.fit === "B" ? "b_to_a" : p.bridge || "both";
          return { ...p, bridge, entity };
        });
      if (picks.length < 3) {
        messages.push({ role: "tool", tool_call_id: plan.id, content: "Rejected: use at least 3 entity ids that appear in the evidence or in recommend results." });
        emit({ type: "note", text: "Plan rejected: picks not grounded in Qloo results, retrying" });
        continue;
      }
      ctx.picked = [...new Set([...(ctx.picked || []), ...picks.map((p) => p.entity_id)])];
      // Send back everything needed to refine later without re-gathering.
      const keep = new Set([...ctx.picked, ...Object.values(evidence).flat().map((e) => e.id)]);
      const entities = [...registry.values()].filter((e) => keep.has(e.id) && !Object.values(evidence).flat().some((x) => x.id === e.id));
      emit({ type: "plan", plan: { ...plan.args, picks }, context: { ...ctx, evidence, entities } });
      return;
    }

    const results = await Promise.all(
      parsed.map(async (c) => {
        try {
          const h = handlers[c.name];
          return h ? await h(c.args) : { error: `Unknown tool ${c.name}` };
        } catch (e) {
          return { error: String(e.message || e) };
        }
      })
    );
    parsed.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(results[i]).slice(0, 5000) }));
  }
  throw new Error("The agent ran out of steps before presenting a plan.");
}
