# Classroom CO2 display

Photon + K30  ->  Particle Cloud  ->  webhook  ->  Cloudflare Worker (this project)  ->  page on the picture frame

```
classroom-co2/
  wrangler.toml      Worker settings (time zone, data retention, database id)
  schema.sql         one table: readings(ts, ppm)
  src/index.js       the Worker: /api/ingest, /api/latest, /api/history
  public/index.html  the display page for the frame
```

The page is served at `https://co2.fittheline.com` (set in `wrangler.toml`) because the school
network blocks `*.workers.dev`. The domain must be in the same Cloudflare account you log in with.

## One-time setup (Windows, Command Prompt, run inside this folder)

Run these from home Wi-Fi or a phone hotspot. On the school network, Wrangler's login fails
with a certificate error. The frame can use the school Wi-Fi afterward.

You need Node.js (https://nodejs.org, the LTS version). Check with `node --version`.

1. Log in to Cloudflare (opens a browser; a free account is enough):
   `npx wrangler login`
2. Create the database:
   `npx wrangler d1 create classroom-co2`
   Copy the `database_id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_DATABASE_ID`.
3. Create the table:
   `npx wrangler d1 execute classroom-co2 --remote --file=schema.sql`
4. Deploy:
   `npx wrangler deploy`
   It sets up `co2.fittheline.com` (the DNS record and certificate are created for you; the
   address can take a few minutes to start working). The first deploy may also ask you to
   pick a workers.dev name, which you can accept; you won't use it.
5. Set the shared secret. Make up a long random string and paste it when asked:
   `npx wrangler secret put INGEST_SECRET`
   Keep a copy, you need it in the Particle console next.

## Particle webhook

Particle console -> Integrations -> New Integration -> Webhook.

| Field | Value |
| --- | --- |
| Event Name | `co2` |
| URL | `https://co2.fittheline.com/api/ingest` |
| Request Type | POST |
| Request Format | JSON |
| Headers (under Advanced Settings) | `X-Webhook-Secret` = the secret from step 5 |
| Enforce SSL | on |

Within a minute of the next publish you should see the number appear at
`https://co2.fittheline.com/`. If it doesn't, open the webhook's
log in the Particle console: a 401 means the secret doesn't match.

## The frame

Open the page address in a kiosk browser on the frame (Fully Kiosk Browser is the usual
choice; check that the version you can install supports Android 6). Optional settings go on
the end of the address:

- The header always reads "Classroom CO2". There is no room name, and anything after `?room=` in the address is ignored
- `&hours=12` changes the chart window (1 to 168 hours)

The page turns gray and says "No new data" if nothing has arrived for 5 minutes, and it
says so if it can't reach the server.

## Things you may want to change

- Color bands and wording: the `BANDS` list at the top of the script in `public/index.html`
  (currently green under 800, yellow 800-999, orange 1,000-1,499, red 1,500 and up).
- Time zone for the clock labels: `TIMEZONE` in `wrangler.toml` (the frame's own clock is not used).
- How long data is kept: `RETENTION_DAYS` in `wrangler.toml`.
- After any change: `npx wrangler deploy` again.

## Notes

- The page address is public: anyone who has the link can see the CO2 number. They can't
  send data in, because that needs the secret.
- Storage is D1, not KV, on purpose. One reading a minute is about 1,440 writes a day, and
  KV's free plan allows 1,000 writes a day. D1's free plan allows 100,000 rows written a day.
