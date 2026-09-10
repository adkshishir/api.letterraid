import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BOT_TIERS, BotTier } from './heist-bot.service.js';

/**
 * How big a share of a *ranked* bot-fallback match's total words a human at
 * this tier should walk away with. Rookie is a brand-new player who should
 * feel like they're winning most exchanges; diamond is the top competitive
 * band, where a bot holding its own is the whole point of playing there.
 * These are the steady-state target the self-tuning loop below pulls each
 * tier's live multipliers toward — not a promise every single match lands
 * exactly here.
 */
const TARGET_HUMAN_SHARE: Record<BotTier, number> = {
  rookie: 0.55,
  bronze: 0.5,
  silver: 0.45,
  gold: 0.4,
  diamond: 0.35,
};

/** How hard one match's outcome pulls the multipliers — small, so one weird blowout can't swing a tier. */
const LEARNING_RATE = 0.35;

const THINK_MULTIPLIER_BOUNDS: readonly [number, number] = [0.5, 2.5];
const WHIFF_MULTIPLIER_BOUNDS: readonly [number, number] = [0.4, 3];

interface Multipliers {
  thinkMultiplier: number;
  whiffMultiplier: number;
}

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.max(min, Math.min(max, value));
}

function defaultMultipliers(): Multipliers {
  return { thinkMultiplier: 1, whiffMultiplier: 1 };
}

/**
 * The "bots train themselves" half of difficulty tuning. `TIER_CONFIG` in
 * `heist-bot.service.ts` stays the hand-picked baseline (multiplier 1.0);
 * this service tracks, per tier, how each *ranked* bot-fallback match
 * actually went — the human's share of the total words claimed — and nudges
 * that tier's think-speed/whiff-rate multipliers toward `TARGET_HUMAN_SHARE`
 * a little after every match. A tier that's still crushing humans drifts
 * slower and miss-happier on its own, without anyone hand-editing
 * `TIER_CONFIG` again.
 *
 * Deliberately fed only from ranked matches (`HeistGateway.endRound`), never
 * practice — a player who explicitly picked "play a diamond bot" to train
 * against isn't a signal that diamond bots are too strong.
 *
 * Multipliers live in an in-memory cache (read on every bot `think()`, so it
 * has to be sync and cheap) and are persisted to `BotDifficultyState` so they
 * survive a restart; the cache is updated immediately on `recordMatchOutcome`
 * so the very next match already benefits, and the DB write trails behind it.
 */
@Injectable()
export class BotDifficultyService implements OnModuleInit {
  private readonly logger = new Logger(BotDifficultyService.name);
  private readonly cache = new Map<BotTier, Multipliers>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    for (const tier of BOT_TIERS) this.cache.set(tier, defaultMultipliers());

    try {
      const rows = await this.prisma.botDifficultyState.findMany();
      for (const row of rows) {
        if (!BOT_TIERS.includes(row.tier as BotTier)) continue;
        this.cache.set(row.tier as BotTier, {
          thinkMultiplier: row.thinkMultiplier,
          whiffMultiplier: row.whiffMultiplier,
        });
      }
    } catch (err) {
      this.logger.error('Failed to load bot difficulty state', err as Error);
    }
  }

  /** Sync and cheap — called from the bot's `think()` loop on every tick. */
  getMultipliers(tier: BotTier): Multipliers {
    return this.cache.get(tier) ?? defaultMultipliers();
  }

  /**
   * Call once per finished *ranked* bot-fallback match. `humanWords`/
   * `botWords` are the final word counts each side claimed that round.
   * A scoreless round (both zero) carries no signal and is skipped.
   */
  async recordMatchOutcome(
    tier: BotTier,
    humanWords: number,
    botWords: number,
  ): Promise<void> {
    const total = humanWords + botWords;
    if (total <= 0) return;

    const share = humanWords / total;
    const target = TARGET_HUMAN_SHARE[tier];
    // Positive when the human did better than target (bot too weak) -> both
    // multipliers should shrink (bot gets faster/sharper). Negative means the
    // bot is still crushing them -> multipliers grow (bot eases off).
    const error = share - target;
    const factor = 1 - error * LEARNING_RATE;

    const current = this.getMultipliers(tier);
    const next: Multipliers = {
      thinkMultiplier: clamp(
        current.thinkMultiplier * factor,
        THINK_MULTIPLIER_BOUNDS,
      ),
      whiffMultiplier: clamp(
        current.whiffMultiplier * factor,
        WHIFF_MULTIPLIER_BOUNDS,
      ),
    };
    this.cache.set(tier, next);

    try {
      const existing = await this.prisma.botDifficultyState.findUnique({
        where: { tier },
      });
      await this.prisma.botDifficultyState.upsert({
        where: { tier },
        create: {
          tier,
          thinkMultiplier: next.thinkMultiplier,
          whiffMultiplier: next.whiffMultiplier,
          matchesSeen: 1,
          lastHumanShare: share,
        },
        update: {
          thinkMultiplier: next.thinkMultiplier,
          whiffMultiplier: next.whiffMultiplier,
          matchesSeen: (existing?.matchesSeen ?? 0) + 1,
          lastHumanShare: share,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist bot difficulty state for tier ${tier}`,
        err as Error,
      );
    }
  }
}
