import { runAgent } from "./agent.js";
import html from "./index.html";

const MAX_ITEMS = 6;

function clean(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s || "").trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, qloo: Boolean(env.QLOO_API_KEY) });
    }

    if (url.pathname === "/api/blend" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Bad JSON" }, { status: 400 });
      }
      const input = {
        a_name: String(body.a_name || "A").slice(0, 24),
        b_name: String(body.b_name || "B").slice(0, 24),
        a_items: clean(body.a_items),
        b_items: clean(body.b_items),
        city: String(body.city || "").slice(0, 60),
        refine: body.refine ? String(body.refine).slice(0, 300) : undefined,
        context: body.context || undefined,
      };
      if (!input.refine && (input.a_items.length < 1 || input.b_items.length < 1)) {
        return Response.json({ error: "Each person needs at least one favorite." }, { status: 400 });
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const emit = (ev) => writer.write(enc.encode(JSON.stringify(ev) + "\n")).catch(() => {});

      ctx.waitUntil(
        (async () => {
          const t0 = Date.now();
          try {
            await runAgent(env, input, emit);
            await emit({ type: "done", ms: Date.now() - t0 });
          } catch (e) {
            await emit({ type: "error", text: String(e.message || e) });
          } finally {
            await writer.close().catch(() => {});
          }
        })()
      );

      return new Response(readable, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
