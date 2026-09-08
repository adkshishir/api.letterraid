/**
 * Shared room vocabulary for every game. Mirrors docs/SOCKET_EVENTS.md — change
 * that doc first if any of these shapes need to move.
 */

import { ApiProperty } from '@nestjs/swagger';

/**
 * Every game LetterRaid serves. Heist is the flagship and, for now, the only
 * one — this stays a union type rather than collapsing to a bare literal so
 * that adding Fence / Crack / Turf (see games/future-docs/) is one word here
 * plus a new module, with no call site needing to change shape.
 */
export type GameId = 'heist';

/**
 * How many players a room holds and how they're divided.
 *
 * Chosen at room creation, not inferred from headcount — `'2v2'` is exactly
 * two fixed teams of two, not a step toward open-ended N-player free-for-all
 * (that's a separate, still-undone idea in ROADMAP.md with its own ambiguous-
 * opponent-steal design problem to solve).
 */
export type RoomMode = '1v1' | '2v2';

export const DEFAULT_ROOM_MODE: RoomMode = '1v1';

export function maxPlayersForMode(mode: RoomMode): number {
  return mode === '2v2' ? 4 : 2;
}

export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'INVALID_NAME'
  | 'INVALID_CODE'
  | 'PROFANITY_REJECTED'
  | 'INVALID_TEAM'
  | 'TEAM_FULL'
  | 'GAME_STARTED';

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

/** Server-side player record. Never sent to clients as-is — see `PublicPlayer`. */
export interface Player {
  /** Stable per-browser UUID from localStorage; survives reconnects. */
  id: string;
  displayName: string;
  /** Current socket, or null while disconnected. For a bot this is a stable
   * synthetic id (`bot:<playerId>:<roomCode>`), never a real socket.io id. */
  socketId: string | null;
  connected: boolean;
  /** When the player last dropped, used by the disconnect grace period. */
  disconnectedAt: number | null;
  /** 0 or 1 in a `'2v2'` room, recomputed from join order; always null in `'1v1'`. */
  team: number | null;
  /** A matchmaker-seeded bot opponent rather than a real connected player. */
  isBot: boolean;
  /**
   * The *human* opponent's live trophies at seat time, stashed here only when
   * this room was created by the matchmaker's bot fallback — see
   * `MatchmakerService.createBotMatch`. `RoomsService` otherwise has no idea
   * what a player's trophies are (that's the auth/DB layer's business), so
   * this is the one place a bot's difficulty tuning can read them from
   * without a fresh query on every `heist:claim`. Undefined for every
   * ordinary human-vs-human room.
   */
  trophies?: number;
}

/** The player shape broadcast to clients. */
export interface PublicPlayer {
  id: string;
  displayName: string;
  connected: boolean;
  team: number | null;
  isBot: boolean;
}

export interface Room {
  code: string;
  game: GameId;
  mode: RoomMode;
  players: Player[];
  createdAt: number;
  lastActivityAt: number;
}

export interface PublicRoom {
  code: string;
  game: GameId;
  mode: RoomMode;
  players: PublicPlayer[];
}

export const DISPLAY_NAME_MAX_LENGTH = 20;

export function toPublicPlayer(player: Player): PublicPlayer {
  return {
    id: player.id,
    displayName: player.displayName,
    connected: player.connected,
    team: player.team,
    isBot: player.isBot,
  };
}

export function toPublicRoom(room: Room): PublicRoom {
  return {
    code: room.code,
    game: room.game,
    mode: room.mode,
    players: room.players.map(toPublicPlayer),
  };
}

/** Response for `GET /rooms/:code` — the one deliberate REST exception, see `RoomsController`. */
export class RoomLookup {
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['heist'] }) game!: GameId;
  @ApiProperty({ enum: ['1v1', '2v2'] }) mode!: RoomMode;
  @ApiProperty() playerCount!: number;
  @ApiProperty() maxPlayers!: number;
  @ApiProperty() joinable!: boolean;
}
