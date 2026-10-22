# TasteBridge

**Two tastes. One shared night.**

TasteBridge is an agent that finds *real* common ground between two people's tastes. Each person lists a few things they love (films, shows, artists, books, podcasts). The agent walks Qloo's cultural taste graph to show where they genuinely overlap, where they pull apart, and what they'd both enjoy next: a film, a series, an artist, a book, a podcast, and (with a city) a place to go together.

**Live demo:** https://tastebridge.q1f0730.workers.dev
Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## The problem

"What should we watch?" is a negotiation, not a search. Couples, new friends, roommates, a parent and a teenager: most recommendation tools optimize for *one* person, so shared picks end up being either one person's taste winning or the bland middle (whatever is most popular). TasteBridge treats the pair as the user and looks for things that rank well for **each person individually**, then explains why in terms both people recognize.

## How it works

```
favorites A ─┐                         ┌─ A alone   ─┐
             ├─ /search ─ /v2/insights/compare ─┼─ B alone   ─┼─ fit scoring ─ LLM agent ─ plan
favorites B ─┘   (resolve)  (shared vs distinct) └─ A + B     ─┘   (both / A→B / B→A)   (tool loop)
                                  × 5–6 domains via /v2/insights
```

1. **Resolve** every favorite to a Qloo entity with `/search` (culture types first, then any type), so "Atlanta" becomes the TV show, not the city.
2. **Compare** the two profiles with `/v2/insights/compare`. TasteBridge keeps only tags that describe taste (style, theme, audience, plot, archetype, mood) and drops trivia (formats, instruments, countries), giving a *shared* set and an *only-A* / *only-B* set. These drive the Venn diagram.
3. **Triangulate** with `/v2/insights` per domain (movie, tv_show, artist, book, podcast, and place when a city is given): one list for A alone, one for B alone, and one for both together. A candidate that ranks in **both** personal lists is marked `fit=both`, the strongest evidence of common ground. Candidates only one side predicts become **bridges** (`A→B` or `B→A`).
4. **Curate** with an LLM tool-use loop (Cloudflare Workers AI, `gpt-oss-120b` with a Llama 4 fallback). The model reads the evidence and may call Qloo again (`recommend`, `search_tags`) before calling `present_plan`. Guardrails in code:
   - every pick must be an entity id Qloo actually returned (no invented titles);
   - nothing either person already listed;
   - at most one pick per domain;
   - the bridge label is set from the evidence, not from the model's guess.
5. **Refine**: "something lighter", "less mainstream", "things we can do at home tonight". The agent keeps the gathered evidence, looks up Qloo tags for the request, re-queries Qloo with those tags plus both people's favorites, and re-plans without repeating earlier picks.

Places use Qloo place-genre tags (cafes, cocktail bars, bookshops, record stores) so you get somewhere two people can actually go together, not a landmark.

Everything streams to the page, so you can watch the agent work: each Qloo lookup, the overlap it found, and the candidates surfacing for each domain.

## Qloo endpoints used

| Endpoint | Purpose |
| --- | --- |
| `GET /search` | Resolve free-text favorites to entities |
| `GET /v2/insights/compare` | Shared vs distinct taste tags between the two people |
| `GET /v2/insights` (`filter.type` = movie, tv_show, artist, book, podcast, place) | Per-person and joint recommendations, with `signal.interests.entities`, `signal.interests.tags`, `filter.location.query`, `filter.tags` |
| `GET /v2/tags` | Turn a follow-up request ("cozy", "comedy", "jazz bar") into valid tag ids |

## Run it yourself

Requirements: a Cloudflare account (Workers AI is on the free plan) and a Qloo hackathon API key.

```bash
npm install
npx wrangler secret put QLOO_API_KEY   # your hackathon key
npm run dev                            # local
npm run deploy                         # publish to workers.dev
```

No build step: `src/index.js` (routes and streaming), `src/agent.js` (gather + agent loop), `src/qloo.js` (Qloo client), `src/index.html` (the whole UI).

Qloo responses are cached in memory per Worker isolate only; no Qloo data is stored in this repository.

## License

MIT, see [LICENSE](LICENSE).
