# LetterRaid — Game Rules

This document is the source of truth for gameplay logic. Anything not specified here is an
implementation detail, but the edge cases below are required behaviour, not suggestions.

Heist came across from Cahoots on 2026-08-15 unchanged — this is its rules section verbatim, plus
the platform notes that still apply. Each future game (see `games/future-docs/`) gets its own
section here when it is built.

---

## Heist

**Genre:** Real-time competitive word race (Anagrams / Snatch lineage). Both players see one
shared pool of letters and race to claim words out of it, or to **steal** words already on the
board. No turns — the property every game in this family is meant to keep.

### Players & Roles
- Exactly 2 players, fully symmetric, playing **simultaneously**. There are no turns.
- Nothing is hidden. The pool, both players' words and both scores are shared by definition, so
  unlike every other game here a single view serves both players.

### The Pool
- The round opens with **8 letters** on the table and runs for **3 minutes**.
- A fresh letter drops every **4 seconds**. The drip is what keeps a stalled board moving —
  without it, a pool neither player can use stays unusable for the rest of the round and the game
  becomes a staring contest over the same eight letters.
- Letters are drawn from a **finite bag in Scrabble's proportions**, refilled when it empties.
  Drawing with replacement can and does deal five Ws in a row, and a three-minute game has no time
  to recover from a pool nobody can spell out of.
- The pool is **topped up to at least 2 vowels**. Left alone, the bag's honest proportions will
  happily deal nine consonants, and a pool you cannot spell out of isn't a hard round — it's a
  dead one.

### Claiming
- A claim is **4 letters or more**, letters only, and must be in the dictionary.
- The dictionary is Debian's SCOWL-based `american-english`, reduced to plain 4–11 letter
  lowercase entries and generated ahead of time — the app never reads a system word list at
  runtime.
- **Words the profanity filter flags are dropped from the dictionary at generation time**, rather
  than warned about at claim time. A game where someone *chooses* what to send can afford to warn
  and let the player decide. Heist is a three-minute race, and a
  confirmation dialog mid-sprint would cost the round it interrupted — so here the word simply
  isn't a word, and the claim bounces like any other.
- Claims are **rate-limited to one per 250ms per player**. Failed claims cost nothing, and a
  scripted client could otherwise walk the dictionary against the pool thousands of times a second
  without ever typing a word.

### Stealing
- A claim may take a word already on the board — either player's — by **reworking it into a longer
  one**, using at least one letter from the pool.
- **The stolen word's letters come with it.** They don't return to the pool. That's what makes a
  steal cheap and worth watching for.
- **A single letter tacked on the end is not a steal.** `CARE → CARES` is refused. This one rule
  is what keeps stealing interesting: without it the whole game collapses into watching for an S,
  every four-letter word on the board is permanently one cheap letter from changing hands, and
  nobody ever has to actually rework anything.
- The player types a word and nothing else; which legal reading it gets is decided server-side.
  **Steals are tried before a plain pool claim, and the opponent's longest word before the
  claimer's own.** A player who types a word that happens to contain something already on the
  board is reaching for it, and the aggressive reading is always the one worth more to them.
- A player may upgrade their own word. It scores as a steal from themselves.

### Scoring
- A word is worth **its length minus 3** — a 4-letter word scores 1, an 8-letter word scores 5.
- **Linear, deliberately.** A quadratic curve would make one nine-letter word worth more than a
  whole round of honest four-letter claims, and the player who lands it early simply wins — there
  would be nothing left to race for.
- Highest total when the clock stops wins. **A draw is a real result here**, not an error state:
  two players can very reasonably finish level on a three-minute board.

### Presence & Disconnects
- A dropped connection **does not stop the clock.** The round is three minutes, and pausing it
  would hand a losing player a way to freeze the board. A reconnect inside that window rejoins a
  round already in progress.
- A deliberate exit ends the round.
- Restart is refused until the clock has run out.

---

---

## Shared Platform Notes

- Every game shares room-code-based matchmaking (create room → share code/link → opponent joins).
  Rooms are exactly 2 players today; `MAX_PLAYERS_PER_ROOM` in
  `backend/src/rooms/room.types.ts` is the single place that decides it, and lifting it for 3+
  player Heist is tracked in `ROADMAP.md`.
- Profanity filtering uses one shared service. Heist doesn't warn at all — flagged words are
  removed from its dictionary ahead of time, because a confirmation dialog inside a three-minute
  race would cost the round it interrupted. A future game where the player *writes* something
  (rather than picking a word off a table) should warn rather than block, the way Cahoots' games
  do.
- **A dropped connection does not pause Heist.** The clock keeps running. Pausing a 3-minute race
  would hand a losing player a way to freeze the board. A future game holding a position worth
  preserving may choose differently, per game.
- Scores are per game and never carried across games. There is no cross-game leaderboard.
- Restart is refused mid-game. It would otherwise let a player who is behind wipe the score.
