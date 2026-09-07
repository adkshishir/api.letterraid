import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomsService } from './rooms.service';
import {
  DEFAULT_ROOM_MODE,
  GameId,
  RoomError,
  RoomErrorCode,
  RoomMode,
  toPublicPlayer,
  toPublicRoom,
} from './room.types';

interface CreatePayload {
  playerId?: unknown;
  displayName?: unknown;
  mode?: unknown;
}

interface JoinPayload extends CreatePayload {
  roomCode?: unknown;
}

interface LeavePayload {
  roomCode?: unknown;
  playerId?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Anything but an exact `'1v1'`/`'2v2'` — including a missing field — falls back to the default. */
function asRoomMode(value: unknown): RoomMode {
  return value === '1v1' || value === '2v2' ? value : DEFAULT_ROOM_MODE;
}

/**
 * Implements the shared `room:*` contract from docs/SOCKET_EVENTS.md.
 *
 * Each game gateway extends this with its own namespace so their game events
 * can't collide, while room creation, joining, presence and reconnection stay a
 * single implementation.
 */
export abstract class BaseRoomGateway implements OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  protected abstract readonly game: GameId;

  constructor(protected readonly rooms: RoomsService) {}

  // ── Events ────────────────────────────────────────────────────────────────

  @SubscribeMessage('room:create')
  handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: CreatePayload,
  ) {
    const playerId = asString(data?.playerId);
    if (!playerId)
      return this.emitError(client, 'INVALID_NAME', 'Missing player id.');

    try {
      const { room, player } = this.rooms.createRoom(
        this.game,
        playerId,
        asString(data?.displayName),
        client.id,
        undefined,
        asRoomMode(data?.mode),
      );

      void client.join(room.code);
      client.emit('room:created', {
        roomCode: room.code,
        players: toPublicRoom(room).players,
        mode: room.mode,
      });
      this.onPlayerReady(room.code, player.id);
    } catch (err) {
      this.emitRoomError(client, err);
    }
  }

  @SubscribeMessage('room:join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinPayload,
  ) {
    const playerId = asString(data?.playerId);
    if (!playerId)
      return this.emitError(client, 'INVALID_NAME', 'Missing player id.');

    try {
      const { room, player, reconnected } = this.rooms.joinRoom(
        asString(data?.roomCode),
        playerId,
        asString(data?.displayName),
        client.id,
      );

      void client.join(room.code);

      const publicRoom = toPublicRoom(room);
      client.emit('room:joined', {
        roomCode: room.code,
        players: publicRoom.players,
        reconnected,
        mode: room.mode,
      });

      // Only the *other* player needs the join broadcast; the joiner already
      // got the full roster above.
      client.to(room.code).emit('room:player-joined', {
        player: toPublicPlayer(player),
        reconnected,
      });

      this.onPlayerReady(room.code, player.id);
    } catch (err) {
      this.emitRoomError(client, err);
    }
  }

  @SubscribeMessage('room:leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: LeavePayload,
  ) {
    const roomCode = asString(data?.roomCode);
    const playerId = asString(data?.playerId);
    if (!roomCode || !playerId) return;

    const room = this.rooms.leaveRoom(roomCode, playerId);
    void client.leave(roomCode);

    if (room) {
      // `temporary: false` distinguishes a deliberate exit from a dropped
      // connection, so the UI can say "Ben left" instead of "reconnecting…".
      this.server
        .to(room.code)
        .emit('room:player-left', { playerId, temporary: false });
    }
    this.onPlayerGone(roomCode, playerId, false);
  }

  handleDisconnect(client: Socket) {
    const result = this.rooms.handleDisconnect(client.id);
    if (!result) return;

    const { room, player } = result;
    this.server
      .to(room.code)
      .emit('room:player-left', { playerId: player.id, temporary: true });

    this.onPlayerGone(room.code, player.id, true);
  }

  // ── Hooks for game subclasses ─────────────────────────────────────────────

  /** Called once a player is in the room and subscribed to its events. */
  protected onPlayerReady(_roomCode: string, _playerId: string): void {}

  /** Called when a player leaves; `temporary` distinguishes a drop from an exit. */
  protected onPlayerGone(
    _roomCode: string,
    _playerId: string,
    _temporary: boolean,
  ): void {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected emitError(client: Socket, code: RoomErrorCode, message: string) {
    client.emit('room:error', { code, message });
  }

  private emitRoomError(client: Socket, err: unknown) {
    if (err instanceof RoomError) {
      this.emitError(client, err.code, err.message);
      return;
    }
    // Never leak an internal stack trace to a game client.
    this.emitError(client, 'ROOM_NOT_FOUND', 'Something went wrong.');
  }
}
