import { HeistService } from './heist.service';
import { HeistBotService, TIER_CONFIG, tierFor } from './heist-bot.service';

const TIERS_BY_SKILL = ['bronze', 'silver', 'gold', 'diamond'] as const;

describe('tierFor', () => {
  it('maps the documented trophy bands to the right tier', () => {
    expect(tierFor(0)).toBe('bronze');
    expect(tierFor(299)).toBe('bronze');
    expect(tierFor(300)).toBe('silver');
    expect(tierFor(799)).toBe('silver');
    expect(tierFor(800)).toBe('gold');
    expect(tierFor(1499)).toBe('gold');
    expect(tierFor(1500)).toBe('diamond');
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
  /** Every field in the four tier configs, walked bronze -> diamond in order. */
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
    bot = new HeistBotService(heist);
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

    // Bronze's think window tops out at 6000ms (before jitter, which can add
    // up to another 20%) — 8s comfortably clears it either way.
    jest.advanceTimersByTime(8_000);

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
    jest.advanceTimersByTime(8_000);

    expect(performClaim).not.toHaveBeenCalled();
  });

  it('stopBot is safe to call for a room with no bot running', () => {
    expect(() => bot.stopBot('NEVER-STARTED')).not.toThrow();
  });

  it('keeps thinking (reschedules) after a claim attempt', () => {
    const performClaim = jest.fn();
    bot.startBot(ROOM, BOT_ID, 0, performClaim);

    jest.advanceTimersByTime(8_000);
    const firstCalls = performClaim.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    jest.advanceTimersByTime(8_000);
    expect(performClaim.mock.calls.length).toBeGreaterThan(firstCalls);
  });
});
