// Classroom CO2 relay.
//   POST /api/ingest   <- Particle webhook (needs X-Webhook-Secret header)
//   GET  /api/latest   -> newest reading and how old it is
//   GET  /api/history  -> readings for the trend chart (?hours=24, max 168)
// Everything else is served from ./public (the display page).

const MAX_PPM = 10000; // anything above this is treated as garbage, the K30 tops out at 5000

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/ingest" && request.method === "POST") {
        return await ingest(request, env);
      }
      if (url.pathname === "/api/latest" && request.method === "GET") {
        return await latest(env);
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        return await cachedHistory(request, url, env, ctx);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err && err.stack ? err.stack : String(err));
      return json({ error: "server error" }, 500);
    }
  },
};

function json(body, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Compare two strings without bailing out at the first difference.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}

async function ingest(request, env) {
  if (!env.INGEST_SECRET) {
    return json({ error: "INGEST_SECRET is not set on the Worker" }, 500);
  }
  const got = request.headers.get("X-Webhook-Secret") || "";
  if (!safeEqual(got, env.INGEST_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  const text = await request.text();
  if (text.length > 4000) {
    return json({ error: "body too large" }, 413);
  }
  // Particle's "JSON" request format sends JSON; its "Web form" format sends form fields.
  // Accept either so a wrong choice in the Particle console does not silently break things.
  const type = (request.headers.get("content-type") || "").toLowerCase();
  let body;
  if (type.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(text));
  } else {
    try {
      body = JSON.parse(text);
    } catch (e) {
      return json({ error: "body is not JSON or form data" }, 400);
    }
  }

  // Particle sends {"event":"co2","data":"520","coreid":"...","published_at":"..."}
  const ppm = parseInt(body && body.data, 10);
  if (!Number.isFinite(ppm) || ppm < 0 || ppm > MAX_PPM) {
    return json({ error: "data is not a valid ppm value" }, 400);
  }

  const ts = nowSec();
  const stmts = [
    env.DB.prepare("INSERT OR REPLACE INTO readings (ts, ppm) VALUES (?, ?)").bind(ts, ppm),
  ];
  // About once an hour (the first reading after the top of the hour), drop old rows.
  if (ts % 3600 < 60) {
    const days = Math.max(1, parseInt(env.RETENTION_DAYS, 10) || 7);
    stmts.push(env.DB.prepare("DELETE FROM readings WHERE ts < ?").bind(ts - days * 86400));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, ts, ppm });
}

// D1's free plan allows 5,000,000 rows read per day. Each history call reads every row in the
// window, so share one answer for 5 minutes at Cloudflare's edge no matter how many pages ask.
async function cachedHistory(request, url, env, ctx) {
  const cache = caches.default;
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await history(url, env);
  if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function tzOf(env) {
  return env.TIMEZONE || "America/Denver";
}

// Newer ICU puts a narrow no-break space before AM/PM. The display font may not have it.
function clean(s) {
  return s.replace(/[  ]/g, " ");
}

async function latest(env) {
  const row = await env.DB.prepare("SELECT ts, ppm FROM readings ORDER BY ts DESC LIMIT 1").first();
  if (!row) {
    return json({ ppm: null, ts: null, age_s: null, updated_label: null });
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzOf(env),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return json({
    ppm: row.ppm,
    ts: row.ts,
    age_s: Math.max(0, nowSec() - row.ts),
    updated_label: clean(fmt.format(new Date(row.ts * 1000))),
  });
}

async function history(url, env) {
  let hours = parseInt(url.searchParams.get("hours"), 10);
  if (!Number.isFinite(hours)) hours = 24;
  hours = Math.min(168, Math.max(1, hours));

  const end = nowSec();
  const start = end - hours * 3600;
  // Aim for roughly 600 points no matter how long the window is. 60 s is the data rate.
  // bucket is an integer we computed ourselves, so it is safe to put in the SQL text.
  const bucket = Math.max(60, Math.ceil((hours * 3600) / 600));

  // One pass over the table (about 60 rows read per hour of window). The peak comes from the
  // per-bucket maximum, so no second scan is needed.
  const rows = await env.DB.prepare(
    "SELECT (ts / " + bucket + ") * " + bucket + " AS t, " +
      "CAST(ROUND(AVG(ppm)) AS INTEGER) AS ppm, MAX(ppm) AS mx " +
      "FROM readings WHERE ts >= ? GROUP BY t ORDER BY t"
  )
    .bind(start)
    .all();

  let peakRow = null;
  for (const r of rows.results || []) {
    if (!peakRow || r.mx >= peakRow.ppm) peakRow = { ts: r.t, ppm: r.mx };
  }

  const tz = tzOf(env);
  let peak = null;
  if (peakRow) {
    const pf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    peak = {
      ppm: peakRow.ppm,
      label: clean(pf.format(new Date(peakRow.ts * 1000))).replace(",", ""),
    };
  }

  return json(
    {
      hours,
      bucket_s: bucket,
      start,
      end,
      points: (rows.results || []).map((r) => [r.t, r.ppm]),
      ticks: makeTicks(start, end, hours, tz),
      peak,
    },
    200,
    "public, max-age=300"
  );
}

// Clock labels along the bottom of the chart, in the classroom's time zone.
function makeTicks(start, end, hours, tz) {
  const step = hours <= 6 ? 1 : hours <= 12 ? 2 : hours <= 48 ? 6 : 24;
  const hourOf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
  const label =
    hours > 48
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
      : new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: true });
  const ticks = [];
  for (let t = Math.ceil(start / 3600) * 3600; t <= end; t += 3600) {
    const d = new Date(t * 1000);
    const h = parseInt(hourOf.format(d), 10) % 24;
    if (h % step === 0) {
      ticks.push({ t, label: clean(label.format(d)) });
    }
  }
  return ticks;
}
