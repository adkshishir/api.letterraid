import { ModerationService } from '../moderation/moderation.service';
import { RoomsService } from '../rooms/rooms.service';
import { HeistGateway } from './heist.gateway';
import { HeistService } from './heist.service';
import { HeistResultsService } from './heist-results.service';
import { HeistBotService } from './heist-bot.service';
import { TournamentsService } from '../tournaments/tournaments.service';
import { PracticeService } from './practice.service';

/**
 * `HeistService.ensureGame` will happily start a round the moment it sees 2
 * players — its own floor is universal, not mode-aware (see the comment on
 * `ensureGame`). Whether that's *early* for the room is the gateway's call:
 * `onPlayerReady` only invokes it once the room is at the mode's capacity.
 * That gating lives here, not in `HeistService`, so it's covered here.
 */
describe('HeistGateway', () => {
  let rooms: RoomsService;
  let heist: HeistService;
  let gateway: HeistGateway;

  beforeEach(() => {
    rooms = new RoomsService(new ModerationService());
    heist = new HeistService();
    const results = {
      startMatch: jest.fn().mockResolvedValue(undefined),
      finishMatch: jest.fn().mockResolvedValue(null),
      recordClaim: jest.fn().mockResolvedValue(undefined),
      discard: jest.fn(),
    } as unknown as HeistResultsService;

    const bot = new HeistBotService(heist);

    const tournaments = {
      recordResult: jest.fn(),
    } as unknown as TournamentsService;

    const practice = {
      isPractice: jest.fn().mockReturnValue(false),
      tierFor: jest.fn().mockReturnValue(null),
      clear: jest.fn(),
    } as unknown as PracticeService;

    gateway = new HeistGateway(rooms, heist, results, bot, tournaments, practice);
    // Broadcasts only fire once a game actually starts and pushes state; a
    // stub is enough since these tests never assert on socket traffic.
    (gateway as unknown as { server: unknown }).server = {
      to: () => ({ emit: () => {} }),
    };
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    rooms.onModuleDestroy();
  });

  const ready = (roomCode: string, playerId: string) =>
    (
      gateway as unknown as {
        onPlayerReady: (roomCode: string, playerId: string) => void;
      }
    ).onPlayerReady(roomCode, playerId);

  it('starts a 1v1 game as soon as 2 players are seated', () => {
    const { room } = rooms.createRoom('heist', 'a', 'Ana', 'sa');
    ready(room.code, 'a');
    expect(heist.getGame(room.code)).toBeNull();

    rooms.joinRoom(room.code, 'b', 'Ben', 'sb');
    ready(room.code, 'b');
    expect(heist.getGame(room.code)).not.toBeNull();
  });

  it('does not start a 2v2 game with only 2 of the 4 seats filled', () => {
    const { room } = rooms.createRoom(
      'heist',
      'a',
      'Ana',
      'sa',
      undefined,
      '2v2',
    );
    ready(room.code, 'a');

    rooms.joinRoom(room.code, 'b', 'Ben', 'sb');
    ready(room.code, 'b');

    expect(heist.getGame(room.code)).toBeNull();
  });

  it('starts a 2v2 game only once all 4 seats are filled', () => {
    const { room } = rooms.createRoom(
      'heist',
      'a',
      'Ana',
      'sa',
      undefined,
      '2v2',
    );
    rooms.joinRoom(room.code, 'b', 'Ben', 'sb');
    rooms.joinRoom(room.code, 'c', 'Cal', 'sc');
    rooms.joinRoom(room.code, 'd', 'Deb', 'sd');
    ready(room.code, 'd');

    const game = heist.getGame(room.code);
    expect(game).not.toBeNull();
    expect(game!.teams.get('a')).toBe(0);
    expect(game!.teams.get('b')).toBe(0);
    expect(game!.teams.get('c')).toBe(1);
    expect(game!.teams.get('d')).toBe(1);
  });
});
