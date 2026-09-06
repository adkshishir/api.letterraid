import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModerationService } from '../moderation/moderation.service';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from './room-code';
import {
  DISPLAY_NAME_MAX_LENGTH,
  GameId,
  MAX_PLAYERS_PER_ROOM,
  Player,
  Room,
  RoomError,
} from './room.types';

/**
 * How long a room survives without activity, per game.
 *
 * Heist is real-time only — a round is three minutes and nobody comes back to
 * one tomorrow — so its rooms are session-scoped and expire quickly. A future
 * game that can be left mid-position (or played asynchronously at all) should
 * get its own, longer entry rather than inheriting this one.
 */
const ROOM_TTL_MS: Record<GameId, number> = {
  heist: 2 * 60 * 60 * 1000, // 2 hours
};

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface JoinResult {
  room: Room;
  player: Player;
  /** True when this was a returning player rather than a new one. */
  reconnected: boolean;
}

export interface DisconnectResult {
  room: Room;
  player: Player;
}

@Injectable()
export class RoomsService implements OnModuleInit, OnModuleDestroy {
  private readonly rooms = new Map<string, Room>();

  /**
   * socketId -> room code. Without this, every disconnect would mean scanning
   * every room's player list, and disconnects are frequent on mobile.
   */
  private readonly socketIndex = new Map<string, string>();

  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly moderation: ModerationService) {}

  onModuleInit() {
    this.sweepTimer = setInterval(
      () => this.sweepExpiredRooms(),
      SWEEP_INTERVAL_MS,
    );
    // Don't hold the process open just for the sweep.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /** @throws RoomError on empty, overlong, or profane names. */
  private validateDisplayName(raw: string): string {
    const name = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name) {
      throw new RoomError('INVALID_NAME', 'Please enter a name.');
    }
    if (name.length > DISPLAY_NAME_MAX_LENGTH) {
      throw new RoomError(
        'INVALID_NAME',
        `Names can be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      );
    }
    if (this.moderation.isProfane(name)) {
      throw new RoomError(
        'PROFANITY_REJECTED',
        'Please choose a different name.',
      );
    }
    return name;
  }

  // ── Room lifecycle ────────────────────────────────────────────────────────

  createRoom(
    game: GameId,
    playerId: string,
    displayName: string,
    socketId: string,
    /** When set, use this code instead of generating one (used by matchmaker). */
    specificCode?: string,
  ): JoinResult {
    const name = this.validateDisplayName(displayName);
    const code = specificCode && !this.rooms.has(specificCode)
      ? specificCode
      : generateRoomCode((candidate) => this.rooms.has(candidate));

    const player: Player = {
      id: playerId,
      displayName: name,
      socketId,
      connected: true,
      disconnectedAt: null,
    };

    const now = Date.now();
    const room: Room = {
      code,
      game,
      players: [player],
      createdAt: now,
      lastActivityAt: now,
    };

    this.rooms.set(code, room);
    this.socketIndex.set(socketId, code);

    return { room, player, reconnected: false };
  }

  /**
   * Joins an existing room, or resumes a seat the player already holds.
   *
   * Resuming is keyed on `playerId` (the client's persisted UUID), never on
   * socket id — socket ids change on every reconnect, so using them would make
   * every dropped connection look like a brand-new player and immediately
   * exhaust the 2-player cap.
   */
  joinRoom(
    rawCode: string,
    playerId: string,
    displayName: string,
    socketId: string,
  ): JoinResult {
    if (!isValidRoomCode(rawCode)) {
      throw new RoomError('INVALID_CODE', 'That room code doesn’t look right.');
    }

    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'No room with that code.');
    }

    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      // Returning player: re-point them at the new socket and clear the
      // disconnect marker. Their name may have changed on another device, so
      // take the newer one when it's valid.
      this.releaseSocket(existing.socketId);
      existing.socketId = socketId;
      existing.connected = true;
      existing.disconnectedAt = null;
      try {
        existing.displayName = this.validateDisplayName(displayName);
      } catch {
        // Keep the previous name rather than blocking a reconnect over it.
      }
      room.lastActivityAt = Date.now();
      this.socketIndex.set(socketId, code);
      return { room, player: existing, reconnected: true };
    }

    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      throw new RoomError('ROOM_FULL', 'This room already has two players.');
    }

    const player: Player = {
      id: playerId,
      displayName: this.validateDisplayName(displayName),
      socketId,
      connected: true,
      disconnectedAt: null,
    };

    room.players.push(player);
    room.lastActivityAt = Date.now();
    this.socketIndex.set(socketId, code);

    return { room, player, reconnected: false };
  }

  /** Explicit, permanent departure — frees the seat for someone else. */
  leaveRoom(rawCode: string, playerId: string): Room | null {
    const room = this.rooms.get(normalizeRoomCode(rawCode));
    if (!room) return null;

    const player = room.players.find((p) => p.id === playerId);
    if (player) this.releaseSocket(player.socketId);

    room.players = room.players.filter((p) => p.id !== playerId);
    room.lastActivityAt = Date.now();

    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return null;
    }
    return room;
  }

  /**
   * Handles a dropped socket.
   *
   * The seat is *kept* — the player is marked disconnected rather than removed,
   * so a phone locking mid-game or a tab reload doesn't cost them their place.
   * Only an explicit `leaveRoom` or room expiry frees a seat.
   */
  handleDisconnect(socketId: string): DisconnectResult | null {
    const code = this.socketIndex.get(socketId);
    if (!code) return null;
    this.socketIndex.delete(socketId);

    const room = this.rooms.get(code);
    if (!room) return null;

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) return null;

    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    room.lastActivityAt = Date.now();

    return { room, player };
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  getRoom(rawCode: string): Room | null {
    if (!isValidRoomCode(rawCode)) return null;
    return this.rooms.get(normalizeRoomCode(rawCode)) ?? null;
  }

  /** Marks activity so an in-progress game doesn't expire under the sweep. */
  touch(rawCode: string): void {
    const room = this.rooms.get(normalizeRoomCode(rawCode));
    if (room) room.lastActivityAt = Date.now();
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /** Drops rooms idle past their game's TTL. Exposed for tests. */
  sweepExpiredRooms(now = Date.now()): number {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivityAt > ROOM_TTL_MS[room.game]) {
        for (const player of room.players) this.releaseSocket(player.socketId);
        this.rooms.delete(code);
        removed += 1;
      }
    }
    return removed;
  }

  private releaseSocket(socketId: string | null): void {
    if (socketId) this.socketIndex.delete(socketId);
  }
}
