/**
 * Shared room vocabulary for every game. Mirrors docs/SOCKET_EVENTS.md — change
 * that doc first if any of these shapes need to move.
 */

/**
 * Every game LetterRaid serves. Heist is the flagship and, for now, the only
 * one — this stays a union type rather than collapsing to a bare literal so
 * that adding Fence / Crack / Turf (see games/future-docs/) is one word here
 * plus a new module, with no call site needing to change shape.
 */
export type GameId = 'heist';

export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'INVALID_NAME'
  | 'INVALID_CODE'
  | 'PROFANITY_REJECTED';

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
  /** Current socket, or null while disconnected. */
  socketId: string | null;
  connected: boolean;
  /** When the player last dropped, used by the disconnect grace period. */
  disconnectedAt: number | null;
}

/** The player shape broadcast to clients. */
export interface PublicPlayer {
  id: string;
  displayName: string;
  connected: boolean;
}

export interface Room {
  code: string;
  game: GameId;
  players: Player[];
  createdAt: number;
  lastActivityAt: number;
}

export interface PublicRoom {
  code: string;
  game: GameId;
  players: PublicPlayer[];
}

export const MAX_PLAYERS_PER_ROOM = 2;

export const DISPLAY_NAME_MAX_LENGTH = 20;

export function toPublicPlayer(player: Player): PublicPlayer {
  return {
    id: player.id,
    displayName: player.displayName,
    connected: player.connected,
  };
}

export function toPublicRoom(room: Room): PublicRoom {
  return {
    code: room.code,
    game: room.game,
    players: room.players.map(toPublicPlayer),
  };
}
