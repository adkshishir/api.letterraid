# LetterRaid

Real-time head-to-head word games. Grab words off a shared table of letters, and steal the ones
your opponent took.

Forked out of Cahoots on **2026-08-15**. Cahoots keeps all five of its games,
including Heist; this project is a separate home for the heist-themed family, which is why the
code is structured for many games even though there is one today.

| | |
|---|---|
| Frontend | Next.js 16 (Turbopack) / React 19 / Tailwind v4 — `frontend/`, port **4041** |
| Backend | NestJS 11 + Socket.io — `backend/`, port **4042** |
| Rooms | 4-character codes, in-memory, no database |
| Deployed | Not yet — see `docs/DEPLOY.md` |

## Games

| Game | Status |
|---|---|
| **Heist** | Built. Real-time, symmetric, fully public, 2 players, 3-minute rounds. |

Queued games live in the Cahoots checkout's `future-docs/` — Fence, Crack, Turf, Cutpurse — and are
not started. LetterRaid's own next steps (3+ player Heist, config variants, the domain) are in
`docs/ROADMAP.md`.

## Getting started

```bash
cd backend  && npm install && npm run start:dev    # :4042
cd frontend && npm install && npm run dev          # :4041
```

Open `http://localhost:4041`, create a room, and open the share link in a second browser to play
both seats.

## Docs

| File | What's in it |
|---|---|
| `docs/RULES.md` | Source of truth for gameplay. Change this before changing game code. |
| `docs/SOCKET_EVENTS.md` | The frontend/backend protocol. Change this before changing either side. |
| `docs/DEPLOY.md` | Ports, DNS, nginx, certbot, and the by-hand deploy. |
| `docs/ROADMAP.md` | What's next for Heist, plus the brand and domain decisions. |

`DESIGN.md`, `SEO.md` and `STACK.md` have not been forked from Cahoots yet — the implementation
carries their decisions (design tokens, the contrast audit, the metadata patterns), but the
written rationale still only exists in the Cahoots repo.

## Adding a game

The architecture is deliberately multi-game. A new game is:

1. `backend/src/<game>/` — service, gateway, types; register in `app.module.ts`.
2. Add it to `GameId` in `backend/src/rooms/room.types.ts` and give it a TTL in `rooms.service.ts`.
3. `frontend/app/<game>/` route, `frontend/components/<game>/` UI, a hook.
4. Add it to `GameId`/`GAME_LABELS` in `frontend/lib/types.ts`, to `GAMES` in
   `app/room/[code]/RoomClient.tsx`, and an accent in `app/globals.css`.

The room registry is namespace-agnostic, so `/room/CODE` share links keep working without naming
the game. Nothing in the shared shell needs to change.
