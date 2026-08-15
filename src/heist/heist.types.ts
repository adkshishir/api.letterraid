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

/** Letters on the table when the clock starts. */
export const STARTING_LETTERS = 8;

/**
 * How often a fresh letter drops into the pool.
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

/** Vowels the pool is topped up to before consonants are drawn again. */
export const MIN_POOL_VOWELS = 2;

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
}

export interface HeistResult {
  scores: HeistScore[];
  /** Null on a draw. */
  winnerId: string | null;
  tied: boolean;
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
