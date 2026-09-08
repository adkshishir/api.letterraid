import { MatchmakerService } from './matchmaker.service';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RoomsService } from '../rooms/rooms.service.js';

interface MatchCreateArgs {
  data: {
    game: string;
    roomCode: string;
    player1Id: string;
    player2Id: string;
  };
}

/** Pulls the `data` a `prisma.match.create` mock was last called with, typed. */
function lastMatchCreateData(create: jest.Mock): MatchCreateArgs['data'] {
  const calls = create.mock.calls as unknown as [MatchCreateArgs][];
  const [args] = calls[calls.length - 1];
  return args.data;
}

/**
 * Covers the bot fallback added to `tick()`: a solo queue entry with nobody
 * else to match against should wait `BOT_FALLBACK_MS`, then get seated
 * against a bot from the roster rather than waiting forever. `PrismaService`
 * and `RoomsService` are stubbed rather than hit for real — same style as
 * `heist.gateway.spec.ts` stubbing `HeistResultsService`.
 */
describe('MatchmakerService bot fallback', () => {
  let prisma: {
    match: { create: jest.Mock };
    player: { findMany: jest.Mock; findUnique: jest.Mock };
  };
  let rooms: { createRoom: jest.Mock; joinRoom: jest.Mock };
  let service: MatchmakerService;

  const BOT = {
    id: 'bot-1',
    displayName: 'Copper Raider',
    trophies: 100,
    isBot: true,
  };

  const enqueueAna = () =>
    service.enqueue({
      playerId: 'human-1',
      displayName: 'Ana',
      trophies: 100,
      joinedAt: Date.now(),
    });

  beforeEach(() => {
    jest.useFakeTimers();

    prisma = {
      match: { create: jest.fn().mockResolvedValue({ id: 'match-1' }) },
      player: {
        findMany: jest.fn().mockResolvedValue([BOT]),
        findUnique: jest.fn().mockResolvedValue({
          id: 'human-1',
          displayName: 'Ana',
          trophies: 100,
        }),
      },
    };

    rooms = { createRoom: jest.fn(), joinRoom: jest.fn() };

    service = new MatchmakerService(
      prisma as unknown as PrismaService,
      rooms as unknown as RoomsService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does not fall back to a bot before BOT_FALLBACK_MS has passed', async () => {
    enqueueAna();

    await jest.advanceTimersByTimeAsync(14_000);

    expect(prisma.match.create).not.toHaveBeenCalled();
    expect(service.getQueueSize()).toBe(1);
  });

  it('falls back to a bot once a solo queue entry has waited long enough', async () => {
    enqueueAna();

    await jest.advanceTimersByTimeAsync(16_000);

    expect(prisma.player.findMany).toHaveBeenCalledWith({
      where: { isBot: true },
    });

    const matchData = lastMatchCreateData(prisma.match.create);
    expect(matchData.game).toBe('heist');
    expect(matchData.player1Id).toBe('human-1');
    expect(matchData.player2Id).toBe(BOT.id);

    // The human seat is created the normal way, but carries the bot flag and
    // the human's own live trophies for the bot's difficulty tuning.
    expect(rooms.createRoom).toHaveBeenCalledWith(
      'heist',
      'human-1',
      'Ana',
      'match:human-1',
      expect.any(String),
      '1v1',
      false,
      100,
    );

    // The bot is joined directly, via a stable synthetic socket id, flagged isBot.
    expect(rooms.joinRoom).toHaveBeenCalledWith(
      expect.any(String),
      BOT.id,
      BOT.displayName,
      expect.stringContaining(`bot:${BOT.id}:`),
      true,
    );

    // Matched — no longer sitting in the human queue.
    expect(service.getQueueSize()).toBe(0);
  });

  it('prefers a bot close to the human’s trophies over a distant one', async () => {
    const near = {
      id: 'bot-near',
      displayName: 'Iron Fox',
      trophies: 120,
      isBot: true,
    };
    const far = {
      id: 'bot-far',
      displayName: 'Diamond Cracker',
      trophies: 2000,
      isBot: true,
    };
    prisma.player.findMany.mockResolvedValue([far, near]);

    enqueueAna();
    await jest.advanceTimersByTimeAsync(16_000);

    expect(lastMatchCreateData(prisma.match.create).player2Id).toBe(near.id);
  });

  it('still matches two humans against each other instead of falling back', async () => {
    enqueueAna();
    service.enqueue({
      playerId: 'human-2',
      displayName: 'Ben',
      trophies: 110,
      joinedAt: Date.now(),
    });

    await jest.advanceTimersByTimeAsync(2_000);

    const matchData = lastMatchCreateData(prisma.match.create);
    expect(matchData.player1Id).toBe('human-1');
    expect(matchData.player2Id).toBe('human-2');
    // Never reached for the bot roster at all.
    expect(prisma.player.findMany).not.toHaveBeenCalled();
  });
});
