import { OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { BaseRoomGateway } from '../rooms/base-room.gateway';
import { RoomsService } from '../rooms/rooms.service';
import { GameId } from '../rooms/room.types';
import { HeistService } from './heist.service';
import { HeistError, ROUND_DURATION_MS } from './heist.types';

const asString = (v: unknown) => (typeof v === 'string' ? v : '');

interface HeistPayload {
  roomCode?: unknown;
  playerId?: unknown;
  word?: unknown;
}

/** The two clocks a room runs: the letter drip and the round itself. */
interface RoomClocks {
  letters: NodeJS.Timeout;
  end: NodeJS.Timeout;
}

/**
 * Heist's namespace: room lifecycle from `BaseRoomGateway`, plus the `heist:*`
 * contract in docs/SOCKET_EVENTS.md.
 *
 * Everything is broadcast. Heist has no hidden state at all — the pool, both
 * boards and both scores are shared by definition — so unlike the other games
 * here there is no per-player payload to build.
 */
@WebSocketGateway({ namespace: 'heist', cors: { origin: true } })
export class HeistGateway extends BaseRoomGateway implements OnModuleDestroy {
  protected readonly game: GameId = 'heist';

  private readonly clocks = new Map<string, RoomClocks>();

  constructor(
    rooms: RoomsService,
    private readonly heist: HeistService,
  ) {
    super(rooms);
  }

  onModuleDestroy() {
    for (const code of [...this.clocks.keys()]) this.stopClocks(code);
  }

  // ── Room hooks ────────────────────────────────────────────────────────────

  protected override onPlayerReady(roomCode: string, playerId: string): void {
    const room = this.rooms.getRoom(roomCode);
    if (!room) return;

    const started = this.heist.ensureGame(
      roomCode,
      room.players.map((p) => p.id),
    );
    if (started && !this.clocks.has(roomCode)) {
      this.startClocks(roomCode);
    }

    this.pushState(roomCode);
    void playerId;
  }

  protected override onPlayerGone(
    roomCode: string,
    _playerId: string,
    temporary: boolean,
  ): void {
    // A dropped connection doesn't stop the clock — the round is 3 minutes and
    // pausing it would hand a losing player a way to freeze the board. A
    // reconnect inside that window rejoins a round already in progress.
    if (temporary) return;
    this.stopClocks(roomCode);
    this.heist.clear(roomCode);
  }

  // ── Heist events ──────────────────────────────────────────────────────────

  @SubscribeMessage('heist:claim')
  handleClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: HeistPayload,
  ) {
    const roomCode = asString(data?.roomCode);
    const playerId = asString(data?.playerId);

    this.guard(client, () => {
      const outcome = this.heist.claim(
        roomCode,
        playerId,
        asString(data?.word),
      );
      this.rooms.touch(roomCode);

      this.emitToRoom(roomCode, 'heist:claimed', {
        playerId: outcome.playerId,
        word: outcome.word,
        points: outcome.points,
        type: outcome.type,
        stolenWord: outcome.stolenWord,
        stolenFrom: outcome.stolenFrom,
      });
      this.pushState(roomCode);
    });
  }

  @SubscribeMessage('heist:restart')
  handleRestart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: HeistPayload,
  ) {
    const roomCode = asString(data?.roomCode);

    this.guard(client, () => {
      this.heist.restart(roomCode);
      this.rooms.touch(roomCode);

      this.emitToRoom(roomCode, 'heist:restarted', {});
      this.startClocks(roomCode);
      this.pushState(roomCode);
    });
  }

  @SubscribeMessage('heist:request-state')
  handleRequestState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: HeistPayload,
  ) {
    const roomCode = asString(data?.roomCode);
    if (!roomCode) return;

    const state = this.heist.getState(roomCode);
    if (state) client.emit('heist:state', state);
  }

  // ── Clocks ────────────────────────────────────────────────────────────────

  private startClocks(roomCode: string) {
    this.stopClocks(roomCode);

    const letters = setInterval(() => {
      const letter = this.heist.flipLetter(roomCode);
      if (letter === null) return;
      this.emitToRoom(roomCode, 'heist:letter', { letter });
      this.pushState(roomCode);
    }, this.heist.letterIntervalMs);

    const end = setTimeout(() => this.endRound(roomCode), ROUND_DURATION_MS);

    letters.unref?.();
    end.unref?.();
    this.clocks.set(roomCode, { letters, end });
  }

  private stopClocks(roomCode: string) {
    const clocks = this.clocks.get(roomCode);
    if (!clocks) return;
    clearInterval(clocks.letters);
    clearTimeout(clocks.end);
    this.clocks.delete(roomCode);
  }

  private endRound(roomCode: string) {
    this.stopClocks(roomCode);

    const result = this.heist.finish(roomCode);
    if (!result) return;

    this.emitToRoom(roomCode, 'heist:game-over', {
      scores: result.scores,
      winnerId: result.winnerId,
      tied: result.tied,
    });
    this.pushState(roomCode);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private emitToRoom(roomCode: string, event: string, payload: unknown) {
    this.server.to(roomCode).emit(event, payload);
  }

  private pushState(roomCode: string) {
    const state = this.heist.getState(roomCode);
    if (state) this.emitToRoom(roomCode, 'heist:state', state);
  }

  /** Converts a thrown HeistError into a `heist:error` for the caller only. */
  private guard(client: Socket, fn: () => void) {
    try {
      fn();
    } catch (err) {
      if (err instanceof HeistError) {
        client.emit('heist:error', { code: err.code, message: err.message });
        return;
      }
      client.emit('heist:error', {
        code: 'NOT_IN_GAME',
        message: 'Something went wrong.',
      });
    }
  }
}
