# Aligned Clinic Hub

Staff website for Aligned Health: cleaning schedule, supplies, CLIA QC, NDC/Lot, sticky notes, admin.

Live at https://aligned-clinic-hub.jacob-d91.workers.dev

- `worker.js` is the whole site (one Cloudflare Worker). Pushing to `main` redeploys it via Cloudflare Workers Builds.
- `wrangler.toml` holds the D1 database binding (`DB`) and the 30-minute cron used for reminder emails.
- `source/` holds the original sources (`Code.gs`, `Index.src.html`) and the build scripts that generate `worker.js`.

No passwords or API keys live in this repo. The Resend key and accounts are stored in the D1 database and set from the Admin tab.

Deploys automatically from the `main` branch via Cloudflare Workers Builds.
