# TasteBridge

**Your taste is your ID.**

TasteBridge is a taste-based social app built on Qloo's cultural taste graph. You pick the films, shows, artists, books and podcasts you love; Qloo turns them into a **Taste ID**. Then an agent finds people whose taste graphs sit close to yours, lets you meet them blind, test how well you know a friend, and plan a night you'll both enjoy.

**Live demo:** https://tastebridge.q1f0730.workers.dev (click "Try it as a demo user", or create an account in 20 seconds)
Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## What you can do

| Feature | What happens | Qloo behind it |
| --- | --- | --- |
| **Taste ID** | A shareable card (`/u/<handle>`) with your favorites, your Qloo taste tags and an AI-named persona ("Whimsical Ghibli Dreamer") | `/search` to pick favorites, `/v2/insights` with `filter.type=urn:tag` for your tag fingerprint, `/v2/insights` for what Qloo would recommend you next |
| **Taste Radar** | Everyone ranked by taste match. Cards are anonymous (persona + a few favorites) until you both wave | Similarity across three Qloo channels: story/style tags, music genres, and overlap of Qloo's next-pick recommendations |
| **Match reveal** | Why you click, one thing Qloo says you'd both enjoy, and a first message drafted from both tastes | `/v2/insights/compare` + joint `/v2/insights` |
| **Taste Duel** | 5 rounds: spot their real favorite hidden among Qloo look-alikes, and guess which item Qloo predicts they'd enjoy more. Scored against ground truth | `/v2/insights` per domain from their favorites |
| **Bridge night** | The original agent: compares two Taste IDs and plans a film, series, album, book, podcast and a place for both | see below |

Demo personas (marked "Demo" in the app) are seeded so the radar is never empty; they always wave back, so the whole flow can be tried alone.

Accounts are username + password (PBKDF2-SHA256, 100k iterations, HttpOnly session cookie) stored in Cloudflare D1 (`schema.sql`).

## How the Bridge agent works

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

```bash
npx wrangler d1 create tastebridge-db              # put the id in wrangler.toml
npx wrangler d1 execute tastebridge-db --remote --file=schema.sql
```

No build step: `src/index.js` (routes and streaming), `src/social.js` (accounts, Taste ID, radar, waves, duels), `src/agent.js` (bridge agent), `src/qloo.js` (Qloo client), `src/app.html` (social app), `src/quick.html` (bridge / quick two-person mode).

Qloo responses are cached in memory per Worker isolate; a user's own Taste ID (favorites, tag fingerprint) is stored in D1 so matching works. No Qloo data or keys are stored in this repository.

## License

MIT, see [LICENSE](LICENSE).
