import { Injectable } from '@nestjs/common';
import { HEIST_DICTIONARY_RAW } from './heist.dictionary';
import {
  CLAIM_MIN_INTERVAL_MS,
  ClaimOutcome,
  ClaimedWord,
  HeistError,
  HeistGame,
  HeistResult,
  HeistScore,
  HeistStateView,
  LETTER_BAG,
  LETTER_INTERVAL_MS,
  MIN_POOL_VOWELS,
  MIN_WORD_LENGTH,
  ROUND_DURATION_MS,
  STARTING_LETTERS,
  VOWELS,
  canSpell,
  isSuffixSteal,
  letterCounts,
  remainder,
  wordPoints,
} from './heist.types';

@Injectable()
export class HeistService {
  private readonly games = new Map<string, HeistGame>();

  /**
   * Built once at startup from the generated word list.
   *
   * A Set rather than a sorted array with a binary search: claims are checked
   * on the hot path of a real-time race, and this is the one lookup that can't
   * be allowed to add latency to a keystroke.
   */
  private readonly dictionary = new Set(HEIST_DICTIONARY_RAW.split(' '));

  /** Exposed so the word list can be sanity-checked without reaching inside. */
  get dictionarySize(): number {
    return this.dictionary.size;
  }

  isWord(word: string): boolean {
    return this.dictionary.has(word);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Starts the clock once both seats are filled.
   *
   * There's no waiting phase: Heist is a race, and a race that starts before
   * the other runner is on the line isn't one.
   */
  ensureGame(
    roomCode: string,
    playerIds: readonly string[],
    now = Date.now(),
  ): HeistGame | null {
    const existing = this.games.get(roomCode);
    if (existing) {
      for (const id of playerIds) {
        if (!existing.playerIds.includes(id)) existing.playerIds.push(id);
      }
      return existing;
    }

    if (playerIds.length < 2) return null;

    const game: HeistGame = {
      roomCode,
      playerIds: [...playerIds],
      pool: [],
      bag: this.freshBag(),
      words: [],
      nextWordId: 1,
      startedAt: now,
      endsAt: now + ROUND_DURATION_MS,
      status: 'playing',
      lastClaimAt: new Map(),
    };
    for (let i = 0; i < STARTING_LETTERS; i++) this.drawInto(game);

    this.games.set(roomCode, game);
    return game;
  }

  getGame(roomCode: string): HeistGame | null {
    return this.games.get(roomCode) ?? null;
  }

  clear(roomCode: string): void {
    this.games.delete(roomCode);
  }

  restart(roomCode: string, now = Date.now()): HeistGame {
    const existing = this.games.get(roomCode);
    if (!existing) throw new HeistError('NOT_IN_GAME', 'No game in progress.');
    if (existing.status !== 'complete') {
      throw new HeistError('GAME_IN_PROGRESS', 'Finish this round first.');
    }

    const game: HeistGame = {
      roomCode,
      playerIds: [...existing.playerIds],
      pool: [],
      bag: this.freshBag(),
      words: [],
      nextWordId: 1,
      startedAt: now,
      endsAt: now + ROUND_DURATION_MS,
      status: 'playing',
      lastClaimAt: new Map(),
    };
    for (let i = 0; i < STARTING_LETTERS; i++) this.drawInto(game);

    this.games.set(roomCode, game);
    return game;
  }

  // ── Letters ───────────────────────────────────────────────────────────────

  private freshBag(): string[] {
    const bag: string[] = [];
    for (const [letter, count] of Object.entries(LETTER_BAG)) {
      for (let i = 0; i < count; i++) bag.push(letter);
    }
    // Fisher–Yates.
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
  }

  /**
   * Moves one letter from the bag to the pool.
   *
   * Vowels are forced when the table is starved of them. Left alone, the bag's
   * honest proportions will happily deal a pool of nine consonants, and a pool
   * you cannot spell out of isn't a hard round — it's a dead one.
   */
  private drawInto(game: HeistGame): string {
    const poolVowels = game.pool.filter((l) => VOWELS.includes(l)).length;
    const wantVowel = poolVowels < MIN_POOL_VOWELS;

    if (game.bag.length === 0) game.bag = this.freshBag();

    let index = wantVowel ? game.bag.findIndex((l) => VOWELS.includes(l)) : 0;
    if (index < 0) {
      // Bag is out of vowels; take a fresh one rather than settle for a
      // consonant the pool already has too many of.
      game.bag = this.freshBag();
      index = game.bag.findIndex((l) => VOWELS.includes(l));
    }

    const [letter] = game.bag.splice(index, 1);
    game.pool.push(letter);
    return letter;
  }

  /** Drops the next letter onto the table. Driven by the gateway's interval. */
  flipLetter(roomCode: string, now = Date.now()): string | null {
    const game = this.games.get(roomCode);
    if (!game || game.status !== 'playing') return null;
    if (now >= game.endsAt) return null;
    return this.drawInto(game);
  }

  /** Milliseconds until the next letter is due — the gateway's tick length. */
  get letterIntervalMs(): number {
    return LETTER_INTERVAL_MS;
  }

  // ── Claiming ──────────────────────────────────────────────────────────────

  /**
   * Claims a word for a player.
   *
   * The claimer types a word and nothing else; which of the legal readings it
   * gets is decided here. Steals are tried before a plain pool claim, and the
   * opponent's longest word before the claimer's own — a player who types a
   * word that happens to contain something already on the board is reaching for
   * it, and the aggressive reading is always the one worth more to them.
   */
  claim(
    roomCode: string,
    playerId: string,
    rawWord: string,
    now = Date.now(),
  ): ClaimOutcome {
    const game = this.requireGame(roomCode, now);
    if (!game.playerIds.includes(playerId)) {
      throw new HeistError('NOT_A_PLAYER', 'You’re not in this game.');
    }

    const last = game.lastClaimAt.get(playerId) ?? 0;
    if (now - last < CLAIM_MIN_INTERVAL_MS) {
      throw new HeistError('RATE_LIMITED', 'Easy — one at a time.');
    }
    game.lastClaimAt.set(playerId, now);

    const word = String(rawWord ?? '')
      .trim()
      .toLowerCase();

    if (!/^[a-z]+$/.test(word) || word.length < MIN_WORD_LENGTH) {
      throw new HeistError(
        'TOO_SHORT',
        `${MIN_WORD_LENGTH} letters or more, letters only.`,
      );
    }
    if (!this.dictionary.has(word)) {
      throw new HeistError('NOT_A_WORD', `“${word}” isn’t in the dictionary.`);
    }

    const poolCounts = letterCounts(game.pool.join(''));

    // Steals, most damaging first.
    const candidates = [...game.words].sort((a, b) => {
      const mine =
        Number(a.ownerId === playerId) - Number(b.ownerId === playerId);
      if (mine !== 0) return mine;
      return b.word.length - a.word.length;
    });

    let blockedBySuffix = false;

    for (const target of candidates) {
      const extra = remainder(word, target.word);
      if (extra === null || extra.length === 0) continue;
      if (!canSpell(letterCounts(extra.join('')), poolCounts)) continue;

      if (isSuffixSteal(word, target.word)) {
        // Legal letters, illegal move. Remembered so the error can say which
        // rule stopped it rather than the generic "you can't spell that".
        blockedBySuffix = true;
        continue;
      }

      return this.takeSteal(game, playerId, word, target, extra);
    }

    // Plain claim out of the pool.
    if (canSpell(letterCounts(word), poolCounts)) {
      return this.takeFromPool(game, playerId, word);
    }

    if (blockedBySuffix) {
      throw new HeistError(
        'SUFFIX_STEAL',
        'One letter on the end isn’t a steal — rework it.',
      );
    }
    throw new HeistError(
      'LETTERS_UNAVAILABLE',
      'Those letters aren’t on the table.',
    );
  }

  private takeFromPool(
    game: HeistGame,
    playerId: string,
    word: string,
  ): ClaimOutcome {
    const used = this.consume(game, [...word]);
    const claimed: ClaimedWord = {
      id: game.nextWordId++,
      word,
      ownerId: playerId,
    };
    game.words.push(claimed);

    return {
      playerId,
      word,
      points: wordPoints(word),
      type: 'pool',
      stolenWord: null,
      stolenFrom: null,
      lettersUsed: used,
    };
  }

  private takeSteal(
    game: HeistGame,
    playerId: string,
    word: string,
    target: ClaimedWord,
    extra: string[],
  ): ClaimOutcome {
    const used = this.consume(game, extra);
    // The stolen word's own letters come with it rather than returning to the
    // pool — that's what makes a steal cheap and worth watching for.
    game.words = game.words.filter((w) => w.id !== target.id);
    game.words.push({ id: game.nextWordId++, word, ownerId: playerId });

    return {
      playerId,
      word,
      points: wordPoints(word),
      type: 'steal',
      stolenWord: target.word,
      stolenFrom: target.ownerId,
      lettersUsed: used,
    };
  }

  /** Removes one instance of each letter from the pool. */
  private consume(game: HeistGame, letters: readonly string[]): string[] {
    for (const letter of letters) {
      const index = game.pool.indexOf(letter);
      if (index >= 0) game.pool.splice(index, 1);
    }
    return [...letters];
  }

  // ── Finishing ─────────────────────────────────────────────────────────────

  /**
   * Stops the clock and scores the round.
   *
   * Idempotent: the gateway's timer and a late claim can both reach it, and the
   * second one through must not re-score a finished board.
   */
  finish(roomCode: string, now = Date.now()): HeistResult | null {
    const game = this.games.get(roomCode);
    if (!game || game.status === 'complete') return null;

    game.status = 'complete';
    game.endsAt = Math.min(game.endsAt, now);
    return this.scores(game);
  }

  private scores(game: HeistGame): HeistResult {
    const scores: HeistScore[] = game.playerIds.map((playerId) => {
      const owned = game.words.filter((w) => w.ownerId === playerId);
      return {
        playerId,
        score: owned.reduce((sum, w) => sum + wordPoints(w.word), 0),
        words: owned.length,
      };
    });

    const best = Math.max(...scores.map((s) => s.score));
    const leaders = scores.filter((s) => s.score === best);

    return {
      scores,
      // A draw is a real result here, not an error state — two players can very
      // reasonably finish level on a three-minute board.
      winnerId: leaders.length === 1 ? leaders[0].playerId : null,
      tied: leaders.length !== 1,
    };
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  /**
   * One view for both players.
   *
   * Heist is the only game here with nothing to hide: the pool, every claimed
   * word and both scores are on the table by definition, so there's no reason
   * to build a payload per seat.
   */
  getState(roomCode: string, now = Date.now()): HeistStateView | null {
    const game = this.games.get(roomCode);
    if (!game) return null;

    const over = game.status === 'complete';

    return {
      status: game.status,
      pool: [...game.pool],
      words: game.words.map((w) => ({
        id: w.id,
        word: w.word,
        ownerId: w.ownerId,
        points: wordPoints(w.word),
      })),
      scores: this.scores(game).scores,
      msRemaining: over ? null : Math.max(0, game.endsAt - now),
      result: over ? this.scores(game) : null,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private requireGame(roomCode: string, now: number): HeistGame {
    const game = this.games.get(roomCode);
    if (!game) throw new HeistError('NOT_IN_GAME', 'No game in progress.');
    if (game.status === 'complete' || now >= game.endsAt) {
      throw new HeistError('GAME_OVER', 'Time’s up.');
    }
    return game;
  }
}
