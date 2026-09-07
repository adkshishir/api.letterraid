import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { maxPlayersForMode } from './room.types';

/**
 * The one deliberate exception to STACK.md's "sockets-only, no REST" rule.
 *
 * Share links are short (`/room/ABCD`) and don't name the game, so the page has
 * to discover which namespace to connect to before opening a socket. Doing that
 * over HTTP also lets the room page render "no such room" without a socket
 * round-trip. This endpoint is discovery only — no gameplay passes through it.
 */
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get(':code')
  lookup(@Param('code') code: string) {
    const room = this.rooms.getRoom(code);
    if (!room) throw new NotFoundException({ code: 'ROOM_NOT_FOUND' });

    // Deliberately minimal: enough to route and to render a join screen, with
    // no player names or game state — this endpoint is unauthenticated and a
    // room code is guessable in principle.
    return {
      code: room.code,
      game: room.game,
      mode: room.mode,
      playerCount: room.players.length,
      maxPlayers: maxPlayersForMode(room.mode),
      joinable: room.players.length < maxPlayersForMode(room.mode),
    };
  }
}
