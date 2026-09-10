import { HeistService } from './heist.service';
import { HeistBotService, TIER_CONFIG, tierFor } from './heist-bot.service';
import { BotDifficultyService } from './bot-difficulty.service';

/** Every tier's multiplier pinned at the TIER_CONFIG baseline (1.0) — these tests exercise TIER_CONFIG itself, not the self-tuning loop. */
const neutralDifficulty = () =>
  ({
    getMultipliers: () => ({ thinkMultiplier: 1, whiffMultiplier: 1 }),
    recordMatchOutcome: jest.fn().mockResolvedValue(undefined),
  }) as unknown as BotDifficultyService;

const TIERS_BY_SKILL = ['rookie', 'bronze', 'silver', 'gold', 'diamond'] as const;

describe('tierFor', () => {
  it('maps the documented trophy bands to the right tier', () => {
    expect(tierFor(0)).toBe('rookie');
    expect(tierFor(99)).toBe('rookie');
    expect(tierFor(100)).toBe('bronze');
    expect(tierFor(399)).toBe('bronze');
    expect(tierFor(400)).toBe('silver');
    expect(tierFor(899)).toBe('silver');
    expect(tierFor(900)).toBe('gold');
    expect(tierFor(1599)).toBe('gold');
    expect(tierFor(1600)).toBe('diamond');
    expect(tierFor(5000)).toBe('diamond');
  });

  it('is monotonically non-decreasing in skill as trophies rise', () => {
    // A denser sweep than the exact band edges above — no trophy count should
    // ever map to a *lower*-skill tier than a smaller trophy count did.
    let lastRank = -1;
    for (let trophies = 0; trophies <= 3000; trophies += 25) {
      const rank = TIERS_BY_SKILL.indexOf(tierFor(trophies));
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
    }
  });
});

describe('TIER_CONFIG', () => {
  /** Every field in the five tier configs, walked rookie -> diamond in order. */
  const ordered = TIERS_BY_SKILL.map((tier) => TIER_CONFIG[tier]);

  const isMonotonic = (values: number[], direction: 'inc' | 'dec') => {
    for (let i = 1; i < values.length; i++) {
      if (direction === 'inc') {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      } else {
        expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
      }
    }
  };

  it('thinks faster (lower thinkMs bounds) at higher skill', () => {
    isMonotonic(
      ordered.map((c) => c.thinkMs[0]),
      'dec',
    );
    isMonotonic(
      ordered.map((c) => c.thinkMs[1]),
      'dec',
    );
  });

  it('whiffs less often at higher skill', () => {
    isMonotonic(
      ordered.map((c) => c.whiffChance),
      'dec',
    );
  });

  it('goes for steals more aggressively at higher skill', () => {
    isMonotonic(
      ordered.map((c) => c.stealAggression),
      'inc',
    );
  });

  it('hunts longer words more at higher skill (length bias only rises)', () => {
    isMonotonic(
      ordered.map((c) => c.lengthBias),
      'inc',
    );
  });

  it('narrows toward "always the best move" at higher skill', () => {
    // A smaller candidate pool and a sharper (lower) falloff base both mean
    // less randomness — Diamond should be the most deterministic tier.
    isMonotonic(
      ordered.map((c) => c.topN),
      'dec',
    );
    isMonotonic(
      ordered.map((c) => c.sharpness),
      'dec',
    );
  });

  it('keeps every probability in [0, 1]', () => {
    for (const config of ordered) {
      expect(config.whiffChance).toBeGreaterThanOrEqual(0);
      expect(config.whiffChance).toBeLessThanOrEqual(1);
    }
  });
});

describe('HeistBotService', () => {
  let heist: HeistService;
  let bot: HeistBotService;

  const ROOM = 'BOT1';
  const HUMAN = 'human';
  const BOT_ID = 'bot-1';

  beforeEach(() => {
    jest.useFakeTimers();
    heist = new HeistService();
    bot = new HeistBotService(heist, neutralDifficulty());
    heist.ensureGame(ROOM, [
      { id: HUMAN, team: null },
      { id: BOT_ID, team: null },
    ]);
  });

  afterEach(() => {
    bot.stopBot(ROOM);
    jest.useRealTimers();
  });

  it('schedules a think and eventually calls performClaim', () => {
    const performClaim = jest.fn<void, [string, string]>();
    bot.startBot(ROOM, BOT_ID, 0, performClaim);

    // Rookie (0 trophies)'s think window tops out at 11000ms, plus up to 20%
    // jitter — 14s comfortably clears it.
    jest.advanceTimersByTime(14_000);

    expect(performClaim).toHaveBeenCalled();
    const [playerId, word] = performClaim.mock.calls[0];
    expect(playerId).toBe(BOT_ID);
    expect(typeof word).toBe('string');
    expect(word.length).toBeGreaterThan(0);
  });

  it('stops cleanly once the game is gone, with no further claims', () => {
    const performClaim = jest.fn();
    bot.startBot(ROOM, BOT_ID, 0, performClaim);

    heist.clear(ROOM);
    jest.advanceTimersByTime(14_000);

    expect(performClaim).not.toHaveBeenCalled();
  });

  it('stopBot is safe to call for a room with no bot running', () => {
    expect(() => bot.stopBot('NEVER-STARTED')).not.toThrow();
  });

  it('keeps thinking (reschedules) after a claim attempt', () => {
    const performClaim = jest.fn();
    // Diamond's tight, low-jitter interval keeps this test fast — the
    // "keeps rescheduling" behavior itself doesn't depend on tier.
    bot.startPracticeBot(ROOM, BOT_ID, 'diamond', performClaim);

    jest.advanceTimersByTime(2_000);
    const firstCalls = performClaim.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    jest.advanceTimersByTime(2_000);
    expect(performClaim.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it('lets a practice match pick an explicit tier regardless of trophies', () => {
    const performClaim = jest.fn();
    bot.startPracticeBot(ROOM, BOT_ID, 'diamond', performClaim);

    // Diamond's think window tops out at 1600ms, plus up to 20% jitter.
    jest.advanceTimersByTime(2_000);

    expect(performClaim).toHaveBeenCalled();
  });

  it('never steals a struggling human’s only word at the rookie tier', () => {
    // Seed the human owning exactly one word directly on the live game object
    // — deterministic, and sidesteps needing the random starting pool to
    // happen to spell a specific word. The bot (rookie) should never take it
    // while she's down to just that one, even across many think cycles.
    const seeded = heist.getGame(ROOM)!;
    seeded.words.push({ id: seeded.nextWordId++, word: 'rice', ownerId: HUMAN });

    const performClaim = jest.fn((playerId: string, word: string) => {
      try {
        heist.claim(ROOM, playerId, word);
      } catch {
        // A whiff — fine, matches production's swallow-and-reschedule behavior.
      }
    });
    bot.startBot(ROOM, BOT_ID, 0, performClaim);

    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(14_000);
    }

    const game = heist.getGame(ROOM)!;
    const anasWord = game.words.find((w) => w.word === 'rice');
    // Either she still owns it, or she's since claimed more than one word
    // (making the mercy rule no longer apply) — never "the bot took her
    // single word".
    const anaWordCount = game.words.filter((w) => w.ownerId === HUMAN).length;
    expect(anasWord?.ownerId === HUMAN || anaWordCount > 1).toBe(true);
  });
});
