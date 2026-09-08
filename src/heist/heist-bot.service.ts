import { Injectable } from '@nestjs/common';
import { HeistService } from './heist.service';
import { MIN_WORD_LENGTH, SuggestedClaim } from './heist.types';

export type BotTier = 'rookie' | 'bronze' | 'silver' | 'gold' | 'diamond';

export const BOT_TIERS: readonly BotTier[] = [
  'rookie',
  'bronze',
  'silver',
  'gold',
  'diamond',
];

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
 * Bot skill, keyed off the *human* opponent's live trophies for a ranked
 * bot-fallback match (`startBot`), or picked explicitly for a practice match
 * (`startPracticeBot`) — see the module doc below. Bounds are monotonic
 * tier-over-tier by design — every field either only increases or only
 * decreases as skill goes up — which is what `heist-bot.service.spec.ts`
 * checks.
 *
 * `rookie` exists because tier alone wasn't gentle enough at the bottom: even
 * a "weak" bot that finds an unremarkable word every few seconds still
 * massively outpaces a genuine first-time player, who might spend a minute
 * finding their first word at all. Rookie leans hard on *quantity* of action
 * (a long, jittery think interval) rather than just move quality, and pairs
 * with the mercy/backoff logic in `think()` below.
 */
export const TIER_CONFIG: Record<BotTier, TierConfig> = {
  rookie: {
    thinkMs: [7000, 11000],
    whiffChance: 0.45,
    stealAggression: 0,
    lengthBias: -0.6,
    topN: 8,
    sharpness: 0.85,
  },
  bronze: {
    thinkMs: [5000, 8000],
    whiffChance: 0.3,
    stealAggression: 0.05,
    lengthBias: -0.5,
    topN: 7,
    sharpness: 0.8,
  },
  silver: {
    thinkMs: [3000, 5000],
    whiffChance: 0.15,
    stealAggression: 0.3,
    lengthBias: -0.2,
    topN: 5,
    sharpness: 0.6,
  },
  gold: {
    thinkMs: [1500, 3000],
    whiffChance: 0.05,
    stealAggression: 0.7,
    lengthBias: 0.1,
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

/** Rookie < 100, Bronze 100-399, Silver 400-899, Gold 900-1599, Diamond >= 1600. */
export function tierFor(trophies: number): BotTier {
  if (trophies < 100) return 'rookie';
  if (trophies < 400) return 'bronze';
  if (trophies < 900) return 'silver';
  if (trophies < 1600) return 'gold';
  return 'diamond';
}

/** Tiers gentle enough to apply the struggling-human mercy/backoff below. */
const GENTLE_TIERS: ReadonlySet<BotTier> = new Set(['rookie', 'bronze']);

/**
 * Extra multiplier on the next think delay while the human hasn't landed a
 * single word yet — only at the gentlest tiers. A fixed think interval reads
 * as a metronome regardless of how the actual game is going; this is the
 * "react to how they're doing" half of the tuning, not just a slower fixed
 * tier.
 */
const STRUGGLING_BACKOFF = 1.7;

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
 * Runs the "think" loop for a bot seated in a Heist room — either the
 * matchmaker's ranked fallback (`startBot`, tier derived from the human's
 * live trophies) or an explicit practice match (`startPracticeBot`, tier
 * chosen by the player from `BOT_TIERS`).
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
  /** roomCode -> the tier its bot is currently playing at. */
  private readonly tiers = new Map<string, BotTier>();

  constructor(private readonly heist: HeistService) {}

  /** Starts (or restarts) a ranked-fallback bot, tier derived from the human's live trophies. */
  startBot(
    roomCode: string,
    botPlayerId: string,
    humanTrophies: number,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    this.begin(roomCode, botPlayerId, tierFor(humanTrophies), performClaim);
  }

  /** Starts (or restarts) a practice bot at an explicitly chosen tier. */
  startPracticeBot(
    roomCode: string,
    botPlayerId: string,
    tier: BotTier,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    this.begin(roomCode, botPlayerId, tier, performClaim);
  }

  /** Clears any pending think for `roomCode`. Safe to call with nothing running there. */
  stopBot(roomCode: string): void {
    const timer = this.timers.get(roomCode);
    if (timer) clearTimeout(timer);
    this.timers.delete(roomCode);
    this.tiers.delete(roomCode);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private begin(
    roomCode: string,
    botPlayerId: string,
    tier: BotTier,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    this.stopBot(roomCode);
    this.tiers.set(roomCode, tier);
    this.scheduleThink(roomCode, botPlayerId, performClaim, 1);
  }

  private scheduleThink(
    roomCode: string,
    botPlayerId: string,
    performClaim: (playerId: string, word: string) => void,
    delayMultiplier: number,
  ): void {
    const tier = this.tiers.get(roomCode);
    if (!tier) return;
    const config = TIER_CONFIG[tier];
    const delay =
      jitter(randomBetween(config.thinkMs[0], config.thinkMs[1])) *
      delayMultiplier;

    const timer = setTimeout(() => {
      this.think(roomCode, botPlayerId, performClaim);
    }, delay);
    timer.unref?.();
    this.timers.set(roomCode, timer);
  }

  private think(
    roomCode: string,
    botPlayerId: string,
    performClaim: (playerId: string, word: string) => void,
  ): void {
    const game = this.heist.getGame(roomCode);
    const tier = this.tiers.get(roomCode);
    if (!game || game.status !== 'playing' || !tier) {
      this.stopBot(roomCode);
      return;
    }

    const config = TIER_CONFIG[tier];
    const candidates = this.heist.suggestClaims(roomCode, {
      playerId: botPlayerId,
    });

    const gentle = GENTLE_TIERS.has(tier);
    const humanId = gentle
      ? (game.playerIds.find((id) => id !== botPlayerId) ?? null)
      : null;
    const humanWordCount = humanId
      ? game.words.filter((w) => w.ownerId === humanId).length
      : 0;

    // Mercy: at the two gentlest tiers, never take a struggling human's last
    // word off the board — someone who's found exactly one thing needs to
    // keep it, not learn the steal mechanic by having it taken immediately.
    const pool =
      gentle && humanWordCount <= 1 && humanId
        ? candidates.filter(
            (c) => c.type !== 'steal' || c.target?.ownerId !== humanId,
          )
        : candidates;

    const whiffChance = clamp01(jitter(config.whiffChance));
    const word =
      Math.random() < whiffChance
        ? this.buildWhiff(game.pool, pool)
        : (this.pickCandidate(pool, config)?.word ??
          this.buildWhiff(game.pool, pool));

    if (word) performClaim(botPlayerId, word);

    // Backoff: a human sitting on zero words gets extra breathing room at the
    // gentlest tiers, on top of the tier's already-slow base interval.
    const delayMultiplier =
      gentle && humanWordCount === 0 ? STRUGGLING_BACKOFF : 1;

    // Reschedule regardless of hit or miss — a whiff is still a "think".
    this.scheduleThink(roomCode, botPlayerId, performClaim, delayMultiplier);
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
