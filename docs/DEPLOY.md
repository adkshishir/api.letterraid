# LetterRaid — Deployment

**Status (2026-08-15):** running on the box and serving through nginx over HTTP. PM2 apps are up
and saved, both vhosts are enabled, and `nginx -t` passes. **Blocked on DNS** — the two A records
below don't exist yet, so the hostnames don't resolve from outside and certbot can't issue
certificates. Everything else is done.

## Current setup

| | Value |
|---|---|
| Frontend | `https://letterraid.adhikarishishir.com.np` → `127.0.0.1:4041` |
| Backend | `https://api.letterraid.adhikarishishir.com.np` → `127.0.0.1:4042` |
| Server IP | `80.225.217.82` |
| Process manager | PM2 (`letterraid-frontend`, `api.letterraid`) |
| Reverse proxy | nginx, one site file per host in `/etc/nginx/sites-available` |
| TLS | Let's Encrypt via certbot |

Ports 4041/4042 were picked because imposter holds 4021/4022 and Cahoots holds 4031/4032.
Verified free with `ss -ltn` on 2026-08-15.

The interim hostname is a placeholder. `letterraid.com` is the intended home — see `ROADMAP.md`
for the domain decision and what it displaces.

## Required DNS — NOT DONE

The zone is on Cloudflare (`bristol.ns.cloudflare.com` / `louis.ns.cloudflare.com`), so these have
to be added there:

```
letterraid.adhikarishishir.com.np       A    80.225.217.82
api.letterraid.adhikarishishir.com.np   A    80.225.217.82
```

**Proxy status must be DNS only (grey cloud)**, matching how `cahoots.adhikarishishir.com.np` is
set up — it resolves straight to `80.225.217.82`. An orange-cloud record hides the origin IP and
puts Cloudflare between the browser and the websocket, which is a different setup than the rest of
the box uses.

Nothing resolves until these exist, and certbot's HTTP-01 challenge needs the hostname to reach
this machine.

## Certificates — NOT DONE (waiting on DNS)

```bash
sudo certbot --nginx \
  -d letterraid.adhikarishishir.com.np \
  -d api.letterraid.adhikarishishir.com.np
```

Certbot rewrites both site files in place, adding the 443 server block and the port-80 redirect —
the same shape the Cahoots files are in now. Renewal is handled by the system-wide certbot timer.

## What is already done

- `/etc/nginx/sites-available/letterraid.adhikarishishir.com.np` → `127.0.0.1:4041`, enabled.
- `/etc/nginx/sites-available/api.letterraid.adhikarishishir.com.np` → `127.0.0.1:4042`, enabled,
  with the websocket upgrade headers and the 300s proxy timeouts.
- `sudo nginx -t` passes; nginx reloaded. (The "protocol options redefined" warnings are
  pre-existing and come from other sites on this box.)
- PM2: `letterraid-frontend` (4041) and `api.letterraid` (4042) online, `pm2 save` run so they
  survive a reboot.
- Verified end to end with a forced Host header: the hub, `/heist`, `/room/[code]`, the OG image
  and `/health` all answer correctly through nginx.

## nginx notes

Both site files must proxy with the websocket upgrade headers — Socket.io needs them. The API file
should raise `proxy_read_timeout` / `proxy_send_timeout` past nginx's 60s default: Heist holds an
open socket for a 3-minute round with a letter dripping every 4 seconds, and a 60s idle timeout
would drop players mid-round.

**Always `sudo nginx -t` before reloading.** This box serves ~40 unrelated sites from one nginx; a
bad config would take all of them down.

## Deploying a change by hand

```bash
# Backend — CORS_ORIGINS is runtime config, no rebuild needed for a domain change
cd /home/ubuntu/games/letterraid/backend
npm run build
pm2 startOrReload ecosystem.config.js --update-env

# Frontend — NEXT_PUBLIC_* are inlined at BUILD time
cd /home/ubuntu/games/letterraid/frontend
npm run build          # reads .env.production
pm2 startOrReload ecosystem.config.js --update-env

pm2 save   # so both survive a reboot
```

## Switching to letterraid.com later

1. Update `frontend/.env.production` **and** `frontend/.github/workflows/deploy.yml` (the `env:`
   block), then **rebuild the frontend** — a pm2 restart alone keeps serving the old URL, because
   those values are baked into the client bundle at build time.
2. Update `CORS_ORIGINS` in `backend/ecosystem.config.js`. Backend-only, so `pm2 restart` is
   enough — no rebuild.
3. Add the nginx site files, `sudo nginx -t`, reload, then certbot for the new hostnames.
4. Keep the old hostnames serving, or 301 them, so room links already pasted into a chat thread
   don't break.

## Known gaps

- The GitHub Actions deploy workflows are `workflow_dispatch`-only and run `git pull origin main`
  on the server. They will fail until the repos are pushed to GitHub and the server copy is a real
  clone. `backend/` and `frontend/` here are local git repos with **no commits and no remote** —
  inherited from Cahoots, which has the same gap.
- `purloin.io` is registered and unpointed. If it stays, it wants a redirect to whatever
  LetterRaid's canonical host ends up being, not its own vhost.
