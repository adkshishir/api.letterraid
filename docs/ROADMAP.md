# LetterRaid — Roadmap

Carried over from `cahoots/docs/HEIST_IDEAS.md` (written 2026-08-13) when Heist was forked into
its own project on 2026-08-15. The adjacent-mode ideas from that document now live one per file in
`games/future-docs/`; what remains here is work on Heist itself and on the project around it.

Nothing below is implemented, except where noted.

**Squads (2v2) shipped 2026-09-07.** Heist rooms can now be created as `'2v2'`: two fixed teams of
two, teams assigned by join order, teammates unstealable, team total decides the round. See
`docs/RULES.md` § Squads (2v2) and `docs/SOCKET_EVENTS.md`. **This is a different idea from "Heist
for 3+ players" below and does not chip away at it** — Squads is exactly two fixed teams of two
with no ambiguous-opponent problem to solve (a steal always targets an opponent-team member, chosen
the same way 1v1 already does), while §1 below is still-undone, open-ended N-player free-for-all
with a genuinely unsolved steal-resolution question. Don't read Squads as a stepping stone toward
it; they're separate designs.

**Clans and Tournaments shipped 2026-09-08.** Two new domains, `backend/src/clans/` and
`backend/src/tournaments/`:

- **Clans** are persistent groups (`Clan`/`ClanMember` — a player belongs to at most one at a
  time). A clan has a roster ranked by member trophies, a leader (auto-succeeded to the
  earliest-joined remaining member on leave, or the clan is deleted if they were the last one),
  and can host tournaments visible only to its own members.
- **Tournaments** are Clash-Royale-style, not brackets: a creator picks a member cap (10/50/100)
  and a duration (30/60/120 min) from a fixed menu, `TournamentsService` derives `OPEN`/`COMPLETE`
  from `endsAt` rather than a background job, and any participant can queue for a 1v1 Heist match
  against another participant at any point before time runs out — no elimination. Standings are
  league-style points (win 3 / tie 1 / loss 0), tracked in `TournamentParticipant` completely
  independent of `HeistResultsService`: a tournament match is an ordinary two-real-player Heist
  room from the ranked pipeline's point of view (trophies/XP update exactly like any other match,
  same as a private "play with friends" room already did), and `TournamentsService.recordResult`
  is a no-op hook `HeistGateway` calls for every room, not just tournament ones.

Frontend: `/clan` gained a Clan/Friends tab split (Clan hub is new; Friends is the pre-existing
private-room flow, now using the account's login name automatically instead of asking for one);
`/tournament` and the new `/tournament/[code]` are fully rebuilt from the old placeholder.

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

- **The player cap.** Done as far as Squads needed it: `maxPlayersForMode` in
  `backend/src/rooms/room.types.ts` is now a per-mode function rather than a single flat
  `MAX_PLAYERS_PER_ROOM = 2`. What Squads did *not* do is make the cap open-ended — `RoomMode` is a
  closed `'1v1' | '2v2'` union on purpose. Going past 4 means widening that union (or replacing it
  with a bare player-count) and is still this section's work, not something Squads did.
- **Steal resolution.** The current rule is "steals are tried before a plain pool claim, and the
  opponent's longest word before the claimer's own." With three or more players *the opponent* is
  ambiguous. Proposed: the longest word anywhere on the board, ties broken toward the player
  currently leading. That keeps the aggressive reading the 2-player rule already prefers and adds
  a mild rubber band — the leader is the most attractive target, which is a feature. **Squads
  sidesteps this rather than solving it:** with exactly two fixed teams, "the opponent" is always
  unambiguous (anyone not on your team), so Squads' teammate-exclusion rule isn't a partial answer
  to this problem and shouldn't be read as one.
- **Pool scaling.** 8 opening letters and a 4-second drip are tuned for two claimers. Four players
  will strip the pool faster than it refills and the round becomes a starve. Opening size and drip
  interval should scale with player count, and the 2-vowel floor should scale with pool size
  rather than staying flat. **Squads did this for the fixed case of 4** — see
  `startingLetters`/`letterIntervalMs`/`minPoolVowels` in `backend/src/heist/heist.types.ts` — but
  those are simple linear formulas picked by feel for exactly two player counts (2 and 4), not
  validated at N, and still worth revisiting if this section is ever built.

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
