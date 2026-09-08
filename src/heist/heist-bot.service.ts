import { Injectable } from '@nestjs/common';
import { HeistService } from './heist.service';
import { MIN_WORD_LENGTH, SuggestedClaim } from './heist.types';

export type BotTier = 'bronze' | 'silver' | 'gold' | 'diamond';

interface TierConfig {
  /** [min, max] milliseconds between "thinks" before jitter is applied. */
  thinkMs: readonly [number, number];
  /** Chance a think submits a deliberately illegal word instead of a real one. */
  whiffChance: number;
  /** How much a steal candidate's score is boosted over an equal-points pool claim. */
  stealAggression: number;
  /** Score bonus (or penalty) per letter beyond `MIN_WORD_LENGTH` — negative biases toward short, safe words. */
  lengthBias: number;
  /** How many top-scored candidates the weighted pick is drawn from. */
  topN: number;
  /**
   * Weight falloff base for the weighted-random pick: `sharpness ** rank`.
   * Close to 1 spreads weight almost evenly across `topN` (more randomness);
   * close to 0 concentrates it on the top candidate ("always play the best move").
   */
  sharpness: number;
}

/**
 * Bot skill keyed off the *human* opponent's live trophies, not the bot
 * persona's own persisted trophies (see the module doc on `HeistBotService`).
 * Bounds are monotonic tier-over-tier by design — every field either only
 * increases or only decreases as skill goes up — which is what
 * `heist-bot.service.spec.ts` checks.
 */
export const TIER_CONFIG: Record<BotTier, TierConfig> = {
  bronze: {
    thinkMs: [3500, 6000],
    whiffChance: 0.2,
    stealAggression: 0.1,
    lengthBias: -0.4,
    topN: 6,
    sharpness: 0.75,
  },
  silver: {
    thinkMs: [2200, 4200],
    whiffChance: 0.1,
    stealAggression: 0.4,
    lengthBias: -0.15,
    topN: 5,
    sharpness: 0.55,
  },
  gold: {
    thinkMs: [1200, 2600],
    whiffChance: 0.04,
    stealAggression: 0.8,
    lengthBias: 0.15,
    topN: 3,
    sharpness: 0.35,
  },
  diamond: {
    thinkMs: [600, 1600],
    whiffChance: 0.01,
    stealAggression: 1.3,
    lengthBias: 0.45,
    topN: 2,
    sharpness: 0.15,
  },
};

/** Bronze < 300, Silver 300-799, Gold 800-1499, Diamond >= 1500. */
export function tierFor(trophies: number): BotTier {
  if (trophies < 300) return 'bronze';
  if (trophies < 800) return 'silver';
  if (trophies < 1500) return 'gold';
  return 'diamond';
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** ±20% random jitter, per the spec's "no two bot games feel identical." */
function jitter(value: number): number {
  return value * (0.8 + Math.random() * 0.4);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Runs the "think" loop for a bot seated in a Heist room by the matchmaker's
 * fallback (see `MatchmakerService.createBotMatch`).
 *
 * Knows nothing about sockets or broadcasting — `performClaim` is injected by
 * the gateway, which routes both bot and human claims through the same
 * `HeistGateway.performClaim` path so a bot's claims are indistinguishable
 * downstream from a real player's. This service only ever reads game state
 * through `HeistService.getGame`/`suggestClaims`, never touches the pool or
 * word list directly, and stops cleanly the moment the game it's watching is
 * gone or no longer `'playing'`.
 */
@Injectable()
export class HeistBotService {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly heist: HeistService) {}

  /** Starts (or restarts) the think loop for a bot in `roomCode`. */
  startBot(
    roomCode: string,
    botPlayerId: string,
    humanTrophies: number,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    this.stopBot(roomCode);
    this.scheduleThink(roomCode, botPlayerId, humanTrophies, performClaim);
  }

  /** Clears any pending think for `roomCode`. Safe to call with nothing running there. */
  stopBot(roomCode: string): void {
    const timer = this.timers.get(roomCode);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(roomCode);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private scheduleThink(
    roomCode: string,
    botPlayerId: string,
    humanTrophies: number,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    const config = TIER_CONFIG[tierFor(humanTrophies)];
    const delay = jitter(randomBetween(config.thinkMs[0], config.thinkMs[1]));

    const timer = setTimeout(() => {
      this.think(roomCode, botPlayerId, humanTrophies, performClaim);
    }, delay);
    timer.unref?.();
    this.timers.set(roomCode, timer);
  }

  private think(
    roomCode: string,
    botPlayerId: string,
    humanTrophies: number,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    const game = this.heist.getGame(roomCode);
    if (!game || game.status !== 'playing') {
      this.stopBot(roomCode);
      return;
    }

    const config = TIER_CONFIG[tierFor(humanTrophies)];
    const candidates = this.heist.suggestClaims(roomCode, {
      playerId: botPlayerId,
    });

    const whiffChance = clamp01(jitter(config.whiffChance));
    const word =
      Math.random() < whiffChance
        ? this.buildWhiff(game.pool, candidates)
        : (this.pickCandidate(candidates, config)?.word ??
          this.buildWhiff(game.pool, candidates));

    if (word) performClaim(botPlayerId, word);

    // Reschedule regardless of hit or miss — a whiff is still a "think".
    this.scheduleThink(roomCode, botPlayerId, humanTrophies, performClaim);
  }

  /**
   * Weighted-random pick among the top `config.topN` candidates by tier
   * score. Lower tiers spread weight more evenly across a bigger pool (more
   * randomness, more of a "human" wobble); Diamond's pool is small and sharp,
   * landing on the best move almost every time.
   */
  private pickCandidate(
    candidates: SuggestedClaim[],
    config: TierConfig,
  ): SuggestedClaim | null {
    if (candidates.length === 0) return null;

    const scored = candidates
      .map((c) => {
        let score = c.points;
        if (c.type === 'steal') score += c.points * config.stealAggression;
        score += (c.word.length - MIN_WORD_LENGTH) * config.lengthBias;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, config.topN);

    const weights = scored.map((_, i) => config.sharpness ** i);
    const total = weights.reduce((sum, w) => sum + w, 0);

    let r = Math.random() * total;
    for (let i = 0; i < scored.length; i++) {
      r -= weights[i];
      if (r <= 0) return scored[i].c;
    }
    return scored[scored.length - 1].c;
  }

  /**
   * A plausible-but-currently-illegal word: the best candidate on the board
   * (or a scrap of the pool, if there's no legal candidate at all) with one
   * random letter tacked on. `HeistService.claim` will bounce it — almost
   * always `NOT_A_WORD` or `LETTERS_UNAVAILABLE` — same as a human typing a
   * word they misjudged the pool for.
   */
  private buildWhiff(
    pool: readonly string[],
    candidates: SuggestedClaim[],
  ): string {
    const base = candidates[0]?.word ?? pool.slice(0, MIN_WORD_LENGTH).join('');
    const junk = String.fromCharCode(97 + Math.floor(Math.random() * 26));
    return `${base}${junk}`;
  }
}
