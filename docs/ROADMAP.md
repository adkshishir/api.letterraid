# LetterRaid — Roadmap

Carried over from `cahoots/docs/HEIST_IDEAS.md` (written 2026-08-13) when Heist was forked into
its own project on 2026-08-15. The adjacent-mode ideas from that document now live one per file in
`games/future-docs/`; what remains here is work on Heist itself and on the project around it.

Nothing below is implemented.

## Why this project exists

Heist is the mode playtesters kept asking for by name, and the reasons are what every idea here
has to preserve:

- **Real-time.** No turns, so nobody ever waits.
- **Symmetric.** Both players do the same thing at the same time. No roles to explain before a
  round can start.
- **Fully public.** The pool, both racks and both scores are shared by definition, so a single
  view serves everyone and there is no hidden state to teach.
- **Unsafe.** Stealing means your score is never banked. Watching the board is worth as much as
  knowing words, which keeps a weaker vocabulary competitive.

LetterRaid widens *that* axis. A game that gives up one of those four properties needs a better
reason than novelty — `games/future-docs/cutpurse.md` is the flagged example.

## 1. Heist for 3+ players

The highest-value extension and the cheapest relative to its impact. Nothing in the design depends
on two players: the pool is public, every rack is public, and there are no turns to sequence.

Three things it forces:

- **The player cap.** `MAX_PLAYERS_PER_ROOM = 2` in `backend/src/rooms/room.types.ts` is shared by
  the whole room registry rather than set per game. In Cahoots that was correct — the other four
  games are genuinely 2-player. Here it's the only thing in the way, and it should become a
  per-game value now that Heist doesn't have to share the constant with anyone.
- **Steal resolution.** The current rule is "steals are tried before a plain pool claim, and the
  opponent's longest word before the claimer's own." With three or more players *the opponent* is
  ambiguous. Proposed: the longest word anywhere on the board, ties broken toward the player
  currently leading. That keeps the aggressive reading the 2-player rule already prefers and adds
  a mild rubber band — the leader is the most attractive target, which is a feature.
- **Pool scaling.** 8 opening letters and a 4-second drip are tuned for two claimers. Four players
  will strip the pool faster than it refills and the round becomes a starve. Opening size and drip
  interval should scale with player count, and the 2-vowel floor should scale with pool size
  rather than staying flat.

Also worth re-checking at N players: the 250ms per-player claim rate limit is a per-player guard
so it needs no change, but total server claim throughput scales linearly with the room. The
frontend also assumes a single opponent in places — `Lobby`, `PlayerPair` and the score display.

## 2. Variants (config, not new code)

These reuse the whole engine and mostly change constants — the cheapest way to give a group of
regulars something new. A preset picker on the room-create screen.

| Preset | Change |
| ------ | ------ |
| **Blitz** | 90 seconds, 6-letter opening pool, 2-second drip. Built for the "one more round" loop. |
| **Longhaul** | 6 minutes, minimum claim length 5. Rewards vocabulary over four-letter spam. |
| **Sudden Death** | First to 15 points, no clock. |
| **No Honor** | Upgrading your own word is banned. Forces attacking other players instead of safely reworking your own rack. |
| **Glass Vault** | Steals may be a single letter tacked on the end — the rule base Heist explicitly refuses. Chaos preset; it is fun *because* it breaks the rule the design defends, which is also why it must stay opt-in and never the default. |

Glass Vault deliberately inverts `RULES.md` § Stealing. That rule is correct for the default game;
the variant exists to be occasionally silly, not to relitigate it.

## 3. Brand and domain

**Decided 2026-08-15:** the game is LetterRaid, and this project is a sibling to Cahoots rather
than a route inside it.

Open:

- **Buy `letterraid.com`** (available as of 2026-08-15, along with `.io` and `.gg`). A free `.com`
  is the main practical argument for the name — every good single-word heist `.com` (`purloin`,
  `filch`, `blag`, `caper`, `heist`) is broker-held.
- **Check "Letter Raid" against app stores and trademark registers** before committing. Not done.
- **Decide what `purloin.io` does.** Registered 2026-08-13 (~$58) for exactly this game, before
  the name changed. Recommendation: redirect it to the canonical host rather than serving from it
   — one game, one canonical origin, no duplicate-content split.
- **`SEO.md` has not been written for this project.** It needs its own `metadataBase`, its own OG
  image (done — see `app/opengraph-image.tsx`), and the `"{Page} | LetterRaid"` title pattern
  (done — see `app/layout.tsx`). What's missing is the written plan, not the implementation.

## 4. What's next

Recommended order: 3+ players first (the most-requested shape and the reason the fork was worth
doing), then the config variants (nearly free), then the first adjacent game from
`games/future-docs/` — Fence is the smallest, Crack is the strongest standalone.
