# LetterRaid — Socket.io Event Contract

The protocol frontend and backend both build against. This is the source of truth for event
names and payloads — change this file first, then both codebases, rather than letting them drift.

Every game is its own Nest gateway/namespace (`/heist`, and one per game added after it), so event
names never collide between games. The shared room lifecycle events below have the same shape in
every namespace, implemented once in a common `BaseRoomGateway`.

Naming convention: `domain:action`. Client→server events are imperative (`room:join`), server→
client events are past-tense or descriptive (`room:joined`).

---

## Shared Room Lifecycle (every namespace)

**Status: implemented in Phase 1** (`backend/src/rooms/base-room.gateway.ts`), extended by every
game gateway. The shapes below are what the server actually emits.

```ts
// Client -> Server
"room:create"   { playerId: string, displayName: string, mode?: "1v1" | "2v2" }
"room:join"     { playerId: string, roomCode: string, displayName: string }
"room:set-team" { playerId: string, roomCode: string, team: 0 | 1 }   // "2v2" only, lobby only
"room:leave"    { playerId: string, roomCode: string }

// Server -> Client
"room:created"       { roomCode: string, players: Player[], mode: "1v1" | "2v2" }
"room:joined"        { roomCode: string, players: Player[], reconnected: boolean, mode: "1v1" | "2v2" } // to the joiner
"room:player-joined" { player: Player, reconnected: boolean }   // to the other player only
"room:roster"        { players: Player[] }   // broadcast to the whole room after a team change
"room:player-left"   { playerId: string, temporary: boolean }
"room:error"         { code: RoomErrorCode, message: string }

type Player = { id: string, displayName: string, connected: boolean, team: number | null, isBot: boolean }

type RoomErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "INVALID_NAME"
  | "INVALID_CODE"        // malformed code, rejected before lookup
  | "PROFANITY_REJECTED"
  | "INVALID_TEAM"        // not "2v2", or not exactly 0/1
  | "TEAM_FULL"           // the requested team already has 2 players
  | "GAME_STARTED"        // room already reached capacity; teams are frozen
```

`playerId` is the client's persisted localStorage UUID and is required on every room event — it's
what makes reconnection work (see Cross-Cutting below).

**`temporary` on `room:player-left`** distinguishes a dropped connection (`true` — the seat is
held, they may return) from a deliberate exit (`false` — the seat is freed). The UI should say
"reconnecting…" for the first and "Ben left" for the second.

**`mode` is chosen at room creation, not auto-detected.** `room:create`'s `mode` field is optional
and defaults to `"1v1"`; any value other than exactly `"1v1"`/`"2v2"` (including a missing field)
falls back to the default too. `mode` on `room:created`/`room:joined` is how every client — the
creator included, since the room page re-joins its own room on mount — learns which one a room is.

**`team` on `Player`** is `0` or `1` in a `"2v2"` room, always `null` in `"1v1"`. On join it
defaults to whichever team has room, filling team 0 first — so the ordinary case (people joining
one after another) pairs the first two arrivals together. A player can move themselves with
`room:set-team` at any point while the lobby is still filling; a leave never reassigns anyone
else's team. Once the room reaches capacity and Heist's round starts, `team` is frozen for that
round and `room:set-team` starts rejecting with `GAME_STARTED`.

**`isBot` on `Player`** is `true` only for a fallback opponent the matchmaker seated after a ranked
queue entry waited too long for a human match (`BOT_FALLBACK_MS` in
`backend/src/match/matchmaker.service.ts`). Bots are real `Player` rows in Postgres — same match
history, trophies and XP path as a human — so this is purely a client-facing "this seat is a bot"
flag, never a signal that the match doesn't count.

- Room codes: **4-character** alphanumeric, uppercase, from the charset
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (excludes ambiguous `0/O`, `1/I`) — this is imposter's exact
  proven generator, ported directly. 4 chars gives ~1M combinations, plenty for concurrent
  ephemeral rooms, and is meaningfully easier to read aloud/type on a phone than 6.
- Room capacity is **per-mode**, not a flat 2 — `maxPlayersForMode` in
  `backend/src/rooms/room.types.ts` is the single place that decides it (2 for `"1v1"`, 4 for
  Heist's `"2v2"` Squads mode). A `room:join` on a full room returns `room:error` with `ROOM_FULL`
  either way.
- **Room codes are unique across all five games**, held in one shared registry. That's what lets a
  short `/room/ABCD` share link resolve without naming the game.
- **Room lifetime is per-game**, set by how much a paused position is worth keeping. A periodic
  sweep (every 10 minutes) drops rooms idle past their TTL.

  | Game   | Idle TTL | Why                                                                 |
  | ------ | -------- | ------------------------------------------------------------------- |
  | Chain  | 7 days   | Originally async by design; a written chain outlives the session.    |
  | Signal | 6 hours  | A grid mid-solve is a position two people built over several turns.  |
  | Sync   | 2 hours  | Real-time, session-scoped; a half-finished blind round has nothing worth resuming. |
  | Hunch  | 2 hours  | Real-time, session-scoped.                                           |
  | Heist  | 2 hours  | The round itself is 3 minutes.                                       |

### `GET /rooms/:code` (the one REST endpoint)

Discovery only, so `/room/[code]` can pick a namespace before opening a socket:

```ts
200 {
  code: string,
  game: "chain" | "sync" | "signal" | "hunch" | "heist",
  mode: "1v1" | "2v2",
  playerCount: number,
  maxPlayers: number,
  joinable: boolean,
}
404 { code: "ROOM_NOT_FOUND" }
```

Deliberately returns no player names or game state — room codes are short and guessable, and this
endpoint is unauthenticated.

---

---

## Heist Namespace (`/heist`)

**Status: implemented.** Shapes below are what the server actually sends.

**Everything is broadcast.** Heist has no hidden state at all — the pool, both boards and both
scores are shared by definition — so unlike every other game here there is no per-player payload to
build, and `heist:request-state` doesn't even need a `playerId`.

```ts
// Client -> Server
"heist:claim"         { roomCode, playerId, word: string }
"heist:restart"       { roomCode, playerId }   // only once the clock has run out
"heist:request-state" { roomCode }

// Server -> Client
"heist:state"     HeistStateView   // authoritative; BROADCAST, sent after every change
"heist:letter"    { letter: string }          // a letter just dropped onto the table
"heist:claimed"   { playerId, word, points, type: "pool" | "steal",
                    stolenWord: string | null, stolenFrom: string | null }
"heist:game-over" { scores: HeistScore[], winnerId: string | null, tied: boolean,
                    teamScores: HeistTeamScore[] | null, winningTeam: number | null }
"heist:restarted" {}
"heist:error"     { code: HeistErrorCode, message: string }   // to the claimer only

type HeistWordView  = { id: number, word: string, ownerId: string, points: number }
type HeistScore     = { playerId: string, score: number, words: number, team: number | null }
type HeistTeamScore = { team: number, score: number, playerIds: string[] }

type HeistStateView = {
  status: "playing" | "complete"
  pool: string[]            // loose letters, in the order they landed
  words: HeistWordView[]
  scores: HeistScore[]
  msRemaining: number | null   // null once the clock has stopped
  result: HeistResult | null
}

type HeistResult = {
  scores: HeistScore[]
  winnerId: string | null      // null on a draw, and always null in a 2v2 game — see below
  tied: boolean
  teamScores: HeistTeamScore[] | null   // null in a 1v1 game
  winningTeam: number | null            // null in 1v1, or in a 2v2 tie
}

type HeistErrorCode =
  | "NOT_IN_GAME" | "NOT_A_PLAYER" | "GAME_OVER" | "GAME_IN_PROGRESS"
  | "TOO_SHORT" | "NOT_A_WORD" | "LETTERS_UNAVAILABLE" | "SUFFIX_STEAL"
  | "RATE_LIMITED" | "WAITING_FOR_PLAYERS"
```

**The clock is server-owned and never pauses.** The round is 3 minutes; a reconnect inside it
rejoins a round already in progress. `msRemaining` on `heist:state` is the only figure a client
should trust — a local countdown is for smoothing between pushes, not for deciding when time is up.

**`heist:claimed` carries `stolenFrom`, which may be the claimer themselves.** A player upgrading
their own word is a legal steal and reports as one.

**In a `"2v2"` game, `team` decides the round instead of `winnerId`.** `HeistScore.team` is `0` or
`1` (always `null` in `"1v1"`); `teamScores` sums each team's members and is `null` when the game
has no teams. `winningTeam` names the higher-scoring team, or `null` on a genuine team tie —
`winnerId` is always `null` in a 2v2 game, even when one teammate individually outscored everyone
else, because the team total is what decides. A teammate's word is never offered as a steal
target — it's not a candidate at all, so it never surfaces as a blocked move either.

**A word's id changes when it is stolen.** The old entry is removed and a new one pushed, so
clients must key word lists on `id` and not on the string.

- The claimer types a word and nothing else; the server decides which legal reading it gets.
  **Steals are tried before a plain pool claim, and the opponent's longest word before the
  claimer's own** — the aggressive reading is always the one worth more to them.
- `SUFFIX_STEAL` is a distinct code on purpose: the letters were legal but the move wasn't
  (`CARE → CARES`), and the error says which rule stopped it rather than the generic "you can't
  spell that". Reasoning in RULES.md.
- `NOT_A_WORD` also covers words the profanity filter removed at dictionary-generation time. Heist
  is the one game that never emits `PROFANITY_WARNING` — a confirmation dialog inside a
  three-minute race would cost the round it interrupted.
- `RATE_LIMITED` fires at more than one claim per 250ms per player. Failed claims are free, so
  without it a scripted client could walk the dictionary against the pool.
- `heist:letter` and `heist:state` both fire on the 4-second drip. The event exists so the new
  letter can be animated; the state push is what's authoritative.
- Errors go **only to the claiming socket**. A missed claim is not news to the opponent, and
  broadcasting it would leak what they're trying to spell.

---

---

## Cross-Cutting

- **Profanity filtering** is checked server-side before anything is broadcast or stored:

  | Surface         | Behaviour                                    | Code                 |
  | --------------- | -------------------------------------------- | -------------------- |
  | Display names   | Reject                                       | `PROFANITY_REJECTED` |
  | `heist:claim`   | Filtered out of the dictionary ahead of time  | `NOT_A_WORD`         |

  A flagged claim bounces as `NOT_A_WORD` like any other non-word — Heist neither warns nor
  rejects, because a dialog inside a three-minute race would cost the round it interrupted.
  Display names reject instead: a name is pushed to the other player and persists for the whole
  match without them agreeing to it word by word.

- **Reconnection:** every namespace supports rejoining an in-progress room via `room:join` with
  the same `roomCode` — a rejoin from a known player resumes rather than erroring `ROOM_FULL`.
  The client generates a UUID once and persists it in `localStorage` under `playerId`, sending it
  on every `room:create` / `room:join`. localStorage (not sessionStorage) is deliberate: the
  identity has to survive a closed tab or a killed mobile browser. Socket IDs change on every
  reconnect and must never be used as player identity.

- All payloads here are the **v1 contract** — extend, don't break. Add new optional fields rather
  than renaming existing ones.
