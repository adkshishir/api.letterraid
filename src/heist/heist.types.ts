/**
 * Heist game state. Rules live in docs/RULES.md — this file is the executable
 * form of them, so change the doc first if a rule needs to move.
 *
 * LetterRaid's flagship game, and the shape every adjacent mode is measured
 * against: both players see one shared **pool** of letters and race to
 * **claim** words out of it, or to **steal** a word already on the board by
 * reworking it into a longer one. Real-time, symmetric, and fully public —
 * nothing is hidden, so a single state view serves every player at the table.
 */

export const ROUND_DURATION_MS = 180_000;

/** Letters on the table when the clock starts. The 2-player default — see `startingLetters`. */
export const STARTING_LETTERS = 8;

/**
 * How often a fresh letter drops into the pool. The 2-player default — see
 * `letterIntervalMsFor`.
 *
 * The drip is what keeps a stalled board moving. Without it a pool that neither
 * player can use stays unusable for the rest of the round, and the game becomes
 * a staring contest over the same eight letters.
 */
export const LETTER_INTERVAL_MS = 4_000;

/** Below four letters a claim is more typing race than word game. */
export const MIN_WORD_LENGTH = 4;

/**
 * Minimum gap between one player's claims.
 *
 * Claims are free when they fail, and a scripted client could otherwise walk
 * the dictionary against the pool several thousand times a second and never
 * type a word at all.
 */
export const CLAIM_MIN_INTERVAL_MS = 250;

/**
 * Consecutive failed claims a player gets before the cooldown starts
 * escalating. Misses this size are just normal human play — a few wrong
 * guesses in a row shouldn't cost anything.
 */
export const CLAIM_FAIL_GRACE = 3;

/**
 * Ceiling for the escalating cooldown. Past the grace window, each further
 * consecutive failure doubles the wait (see `claimCooldownMs`), capped here
 * so a bad streak degrades play without locking anyone out outright — the
 * point is to make a script walking the dictionary against the live pool
 * too slow to be worth running, not to punish a human having an off round.
 */
export const CLAIM_MAX_INTERVAL_MS = 5_000;

/**
 * Gap a *correct* claim needs from the one before it to count as a clean
 * reset rather than another entry in the fail streak.
 *
 * The escalating cooldown below was built to stop a script walking the
 * dictionary against the pool — but a script hopped up with its own
 * pre-checked word list barely ever fails, so it was skating under that
 * defense at the bare `CLAIM_MIN_INTERVAL_MS` floor indefinitely. A real
 * player reading a shared pool and typing a word doesn't sustain a pace
 * under this; treating a fast correct claim like a near-miss for streak
 * purposes closes that gap without touching the score or the claim itself.
 */
export const CLAIM_PLAUSIBLE_GAP_MS = 600;

/**
 * The cooldown a player's next claim must clear, given how many of their
 * claims in a row have failed. Flat at `CLAIM_MIN_INTERVAL_MS` through the
 * grace window, then doubles per additional consecutive failure up to
 * `CLAIM_MAX_INTERVAL_MS`.
 */
export function claimCooldownMs(consecutiveFails: number): number {
  const overGrace = Math.max(0, consecutiveFails - CLAIM_FAIL_GRACE + 1);
  return Math.min(
    CLAIM_MIN_INTERVAL_MS * 2 ** overGrace,
    CLAIM_MAX_INTERVAL_MS,
  );
}

/** Vowels the pool is topped up to before consonants are drawn again. The 2-player default. */
export const MIN_POOL_VOWELS = 2;

// ── Pool scaling ─────────────────────────────────────────────────────────────
//
// Squads (2v2) doubles the claimers racing the same board, so the pool needs
// to be bigger and refill faster or four players strip it dry between drops.
// These are tuned by feel, not derived from anything — simple linear formulas
// kept in one place so they're easy to retune later. Computed once per game at
// creation time from the actual player count, then stored on `HeistGame`
// rather than recomputed per letter draw.

/** 8 letters for 2 players, 12 for 4. */
export function startingLetters(playerCount: number): number {
  return 8 + (playerCount - 2) * 2;
}

/** 4s for 2 players, 3s for 4 — floored at 2s so the drip never gets silly. */
export function letterIntervalMs(playerCount: number): number {
  return Math.max(2000, 4000 - (playerCount - 2) * 500);
}

/** Scales with pool size rather than staying flat, same reasoning as the opening pool. */
export function minPoolVowels(playerCount: number): number {
  return Math.ceil(startingLetters(playerCount) / 4);
}

export const VOWELS = 'aeiou';

/**
 * The letter bag, in Scrabble's proportions.
 *
 * Kept as counts rather than a flat weighting so the bag is *finite*: drawing
 * with replacement can and does deal five Ws in a row, and a three-minute game
 * has no time to recover from a pool nobody can spell out of.
 */
export const LETTER_BAG: Readonly<Record<string, number>> = {
  a: 9,
  b: 2,
  c: 2,
  d: 4,
  e: 12,
  f: 2,
  g: 3,
  h: 2,
  i: 9,
  j: 1,
  k: 1,
  l: 4,
  m: 2,
  n: 6,
  o: 8,
  p: 2,
  q: 1,
  r: 6,
  s: 4,
  t: 6,
  u: 4,
  v: 2,
  w: 2,
  x: 1,
  y: 2,
  z: 1,
};

export type HeistStatus = 'playing' | 'complete';

export interface ClaimedWord {
  id: number;
  word: string;
  ownerId: string;
}

export interface HeistGame {
  roomCode: string;
  playerIds: string[];
  /**
   * playerId -> team (0 or 1), or null for everyone in a 1v1 game. Frozen at
   * `ensureGame`/`restart` time from the room's live assignment — a room's
   * `Player.team` can keep changing after this (nothing downstream re-reads
   * it), but a round in progress must not have its teams reshuffled mid-play.
   */
  teams: Map<string, number | null>;
  /** Letters on the table, in the order they landed. */
  pool: string[];
  /** What's left to draw. Refilled from `LETTER_BAG` when it empties. */
  bag: string[];
  words: ClaimedWord[];
  nextWordId: number;
  startedAt: number;
  endsAt: number;
  status: HeistStatus;
  /** playerId -> epoch ms of their last claim attempt, for the rate limit. */
  lastClaimAt: Map<string, number>;
  /** playerId -> claims in a row that failed, for the escalating cooldown. */
  consecutiveFails: Map<string, number>;
  /** Vowel floor for this game's pool size — see `minPoolVowels`. */
  minPoolVowels: number;
  /** Drip rate for this game's player count — see `letterIntervalMs`. */
  letterIntervalMs: number;
}

export type HeistErrorCode =
  | 'NOT_IN_GAME'
  | 'NOT_A_PLAYER'
  | 'GAME_OVER'
  | 'GAME_IN_PROGRESS'
  | 'TOO_SHORT'
  | 'NOT_A_WORD'
  | 'LETTERS_UNAVAILABLE'
  | 'SUFFIX_STEAL'
  | 'RATE_LIMITED'
  | 'WAITING_FOR_PLAYERS';

export class HeistError extends Error {
  constructor(
    readonly code: HeistErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HeistError';
  }
}

// ── Client-facing views ─────────────────────────────────────────────────────

export interface HeistWordView {
  id: number;
  word: string;
  ownerId: string;
  points: number;
}

export interface HeistScore {
  playerId: string;
  score: number;
  words: number;
  /** 0 or 1 in a 2v2 game, null in 1v1. */
  team: number | null;
}

/** A team's combined total. Only present in a 2v2 game — see `HeistResult.teamScores`. */
export interface HeistTeamScore {
  team: number;
  score: number;
  playerIds: string[];
}

export interface HeistResult {
  scores: HeistScore[];
  /**
   * Null on a draw, and always null in a 2v2 game — the team total decides a
   * Squads round, not any one player's score, so there's no individual
   * "winner" to name even when one teammate outscored the other.
   */
  winnerId: string | null;
  tied: boolean;
  /** Null when the game has no teams (1v1). */
  teamScores: HeistTeamScore[] | null;
  /** Null in 1v1, or in a 2v2 tie. */
  winningTeam: number | null;
}

export interface HeistStateView {
  status: HeistStatus;
  pool: string[];
  words: HeistWordView[];
  scores: HeistScore[];
  /** Milliseconds left on the clock, or null once it has stopped. */
  msRemaining: number | null;
  result: HeistResult | null;
}

export type ClaimType = 'pool' | 'steal';

/**
 * A ranked, legal candidate claim against a room's live pool — see
 * `HeistService.suggestClaims`. Anything returned here is guaranteed legal by
 * construction (built from the same `canSpell`/`remainder`/`isSuffixSteal`
 * helpers `HeistService.claim` itself checks against), so a caller can submit
 * `word` as-is without re-validating it.
 */
export interface SuggestedClaim {
  word: string;
  points: number;
  type: ClaimType;
  /** The word this would steal. Present only when `type` is `'steal'`. */
  target?: ClaimedWord;
}

export interface ClaimOutcome {
  playerId: string;
  word: string;
  points: number;
  type: ClaimType;
  /** The word taken, on a steal. */
  stolenWord: string | null;
  /** Who held it. The claimer themselves, when a player upgrades their own. */
  stolenFrom: string | null;
  /** Pool letters the claim consumed. */
  lettersUsed: string[];
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * What a word is worth.
 *
 * Linear in length, deliberately. A quadratic curve would make one nine-letter
 * word worth more than a whole round of honest four-letter claims, and the
 * player who lands it early simply wins — there'd be nothing left to race for.
 */
export function wordPoints(word: string): number {
  return Math.max(0, word.length - (MIN_WORD_LENGTH - 1));
}

// ── Letters ─────────────────────────────────────────────────────────────────

/** Letter -> count. The shape every claim check is decided on. */
export function letterCounts(word: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of word) {
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  return counts;
}

/** True when `available` holds at least as many of every letter in `needed`. */
export function canSpell(
  needed: Map<string, number>,
  available: Map<string, number>,
): boolean {
  for (const [letter, count] of needed) {
    if ((available.get(letter) ?? 0) < count) return false;
  }
  return true;
}

/**
 * The letters of `word` left over after `base` is used up, or null when `base`
 * isn't contained in `word` at all.
 */
export function remainder(word: string, base: string): string[] | null {
  const left = letterCounts(word);
  for (const letter of base) {
    const count = left.get(letter) ?? 0;
    if (count === 0) return null;
    left.set(letter, count - 1);
  }

  const out: string[] = [];
  for (const [letter, count] of left) {
    for (let i = 0; i < count; i++) out.push(letter);
  }
  return out;
}

/**
 * True when the only change is a single letter tacked on the end.
 *
 * The one rule that keeps stealing interesting. Without it the whole game
 * collapses into watching for an S: every four-letter word on the board is
 * permanently one cheap letter from changing hands, and nobody ever has to
 * actually rework anything.
 */
export function isSuffixSteal(word: string, base: string): boolean {
  return word.length === base.length + 1 && word.startsWith(base);
}

/**
 * True only for two *different* players sharing a non-null team.
 *
 * `a === b` returns false on purpose — self-upgrade is a legal steal from
 * yourself in every mode, and teammates being unstealable must never be read
 * to also mean a player can't rework their own word.
 */
export function isTeammate(
  teams: Map<string, number | null>,
  a: string,
  b: string,
): boolean {
  if (a === b) return false;
  const teamA = teams.get(a) ?? null;
  const teamB = teams.get(b) ?? null;
  return teamA !== null && teamA === teamB;
}
