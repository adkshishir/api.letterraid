import { ModerationService } from '../moderation/moderation.service';
import { RoomsService } from './rooms.service';
import { GameId, MAX_PLAYERS_PER_ROOM, RoomError } from './room.types';

describe('RoomsService', () => {
  let service: RoomsService;

  beforeEach(() => {
    service = new RoomsService(new ModerationService());
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  const create = (game: GameId = 'heist') =>
    service.createRoom(game, 'player-a', 'Ana', 'socket-a');

  describe('createRoom', () => {
    it('creates a room holding the creator', () => {
      const { room, player } = create();
      expect(room.players).toHaveLength(1);
      expect(player.displayName).toBe('Ana');
      expect(player.connected).toBe(true);
      expect(service.getRoom(room.code)).toBe(room);
    });

    it('normalises whitespace in display names', () => {
      const { player } = service.createRoom(
        'heist',
        'p',
        '  Ana   Marie \n',
        's',
      );
      expect(player.displayName).toBe('Ana Marie');
    });

    it('rejects an empty name', () => {
      expect(() => service.createRoom('heist', 'p', '   ', 's')).toThrow(
        RoomError,
      );
    });

    it('rejects an overlong name', () => {
      expect(() =>
        service.createRoom('heist', 'p', 'x'.repeat(21), 's'),
      ).toThrow(/at most 20/);
    });

    it('rejects a profane name with a distinct error code', () => {
      try {
        service.createRoom('heist', 'p', 'fuck', 's');
        throw new Error('expected a RoomError');
      } catch (err) {
        expect((err as RoomError).code).toBe('PROFANITY_REJECTED');
      }
    });
  });

  describe('joinRoom', () => {
    it('adds a second player', () => {
      const { room } = create();
      const result = service.joinRoom(room.code, 'player-b', 'Ben', 'socket-b');
      expect(result.reconnected).toBe(false);
      expect(result.room.players).toHaveLength(2);
    });

    it('accepts a lowercased, padded code', () => {
      const { room } = create();
      const result = service.joinRoom(
        `  ${room.code.toLowerCase()} `,
        'player-b',
        'Ben',
        'socket-b',
      );
      expect(result.room.code).toBe(room.code);
    });

    it('rejects a malformed code before looking it up', () => {
      try {
        service.joinRoom('!!', 'p', 'Ben', 's');
        throw new Error('expected a RoomError');
      } catch (err) {
        expect((err as RoomError).code).toBe('INVALID_CODE');
      }
    });

    it('reports an unknown room', () => {
      try {
        service.joinRoom('ZZZZ', 'p', 'Ben', 's');
        throw new Error('expected a RoomError');
      } catch (err) {
        expect((err as RoomError).code).toBe('ROOM_NOT_FOUND');
      }
    });

    it('rejects a third player', () => {
      const { room } = create();
      service.joinRoom(room.code, 'player-b', 'Ben', 'socket-b');
      try {
        service.joinRoom(room.code, 'player-c', 'Cal', 'socket-c');
        throw new Error('expected a RoomError');
      } catch (err) {
        expect((err as RoomError).code).toBe('ROOM_FULL');
      }
      expect(room.players).toHaveLength(MAX_PLAYERS_PER_ROOM);
    });

    describe('reconnection', () => {
      it('resumes the same seat rather than consuming a second one', () => {
        // The core reason player identity is a persisted UUID and not a socket
        // id: a reconnect must not look like a new player.
        const { room } = create();
        service.handleDisconnect('socket-a');

        const result = service.joinRoom(
          room.code,
          'player-a',
          'Ana',
          'socket-a2',
        );

        expect(result.reconnected).toBe(true);
        expect(room.players).toHaveLength(1);
        expect(result.player.connected).toBe(true);
        expect(result.player.socketId).toBe('socket-a2');
        expect(result.player.disconnectedAt).toBeNull();
      });

      it('lets a full room’s player return even though no seat is free', () => {
        const { room } = create();
        service.joinRoom(room.code, 'player-b', 'Ben', 'socket-b');
        service.handleDisconnect('socket-b');

        const result = service.joinRoom(
          room.code,
          'player-b',
          'Ben',
          'socket-b2',
        );

        expect(result.reconnected).toBe(true);
        expect(room.players).toHaveLength(2);
      });

      it('takes an updated display name', () => {
        const { room } = create();
        const result = service.joinRoom(
          room.code,
          'player-a',
          'Ana B',
          'socket-a2',
        );
        expect(result.player.displayName).toBe('Ana B');
      });

      it('keeps the old name rather than blocking a reconnect over a bad one', () => {
        // Being locked out of an in-progress game because of a name is a worse
        // outcome than keeping the name they already had.
        const { room } = create();
        const result = service.joinRoom(room.code, 'player-a', '', 'socket-a2');
        expect(result.reconnected).toBe(true);
        expect(result.player.displayName).toBe('Ana');
      });
    });
  });

  describe('handleDisconnect', () => {
    it('keeps the seat and marks the player disconnected', () => {
      const { room } = create();
      const result = service.handleDisconnect('socket-a');

      expect(result?.player.connected).toBe(false);
      expect(result?.player.socketId).toBeNull();
      expect(result?.player.disconnectedAt).toEqual(expect.any(Number));
      // Seat retained — a locked phone must not cost a player their place.
      expect(room.players).toHaveLength(1);
      expect(service.getRoom(room.code)).not.toBeNull();
    });

    it('ignores an unknown socket', () => {
      expect(service.handleDisconnect('nope')).toBeNull();
    });

    it('ignores a repeated disconnect for the same socket', () => {
      create();
      service.handleDisconnect('socket-a');
      expect(service.handleDisconnect('socket-a')).toBeNull();
    });
  });

  describe('leaveRoom', () => {
    it('frees the seat', () => {
      const { room } = create();
      service.joinRoom(room.code, 'player-b', 'Ben', 'socket-b');

      const updated = service.leaveRoom(room.code, 'player-b');

      expect(updated?.players).toHaveLength(1);
      // Seat is genuinely free again, unlike after a disconnect.
      expect(() =>
        service.joinRoom(room.code, 'player-c', 'Cal', 'socket-c'),
      ).not.toThrow();
    });

    it('deletes the room once the last player leaves', () => {
      const { room } = create();
      expect(service.leaveRoom(room.code, 'player-a')).toBeNull();
      expect(service.getRoom(room.code)).toBeNull();
      expect(service.roomCount).toBe(0);
    });

    it('is a no-op for an unknown room', () => {
      expect(service.leaveRoom('ZZZZ', 'p')).toBeNull();
    });
  });

  describe('sweepExpiredRooms', () => {
    it('expires a Heist room once its TTL passes', () => {
      // Heist is real-time and session-scoped: a round is three minutes, and
      // nobody returns to an abandoned table (docs/RULES.md).
      const { room } = create('heist');
      const threeHoursLater = Date.now() + 3 * 60 * 60 * 1000;

      expect(service.sweepExpiredRooms(threeHoursLater)).toBe(1);
      expect(service.getRoom(room.code)).toBeNull();
    });

    it('keeps a Heist room alive inside its TTL', () => {
      const { room } = create('heist');
      const oneHourLater = Date.now() + 60 * 60 * 1000;

      expect(service.sweepExpiredRooms(oneHourLater)).toBe(0);
      expect(service.getRoom(room.code)).not.toBeNull();
    });

    it('does not expire a room kept active by play', () => {
      const { room } = create('heist');
      const later = Date.now() + 3 * 60 * 60 * 1000;

      // Simulate ongoing play just before the sweep runs.
      jest.spyOn(Date, 'now').mockReturnValue(later);
      service.touch(room.code);
      jest.restoreAllMocks();

      expect(service.sweepExpiredRooms(later + 1000)).toBe(0);
      expect(service.getRoom(room.code)).not.toBeNull();
    });
  });

  describe('getRoom', () => {
    it('returns null for a malformed code instead of throwing', () => {
      expect(service.getRoom('nope!')).toBeNull();
    });
  });
});
