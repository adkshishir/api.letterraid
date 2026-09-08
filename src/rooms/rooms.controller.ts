import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoomsService } from './rooms.service';
import { RoomLookup, maxPlayersForMode } from './room.types';

/**
 * The one deliberate exception to STACK.md's "sockets-only, no REST" rule.
 *
 * Share links are short (`/room/ABCD`) and don't name the game, so the page has
 * to discover which namespace to connect to before opening a socket. Doing that
 * over HTTP also lets the room page render "no such room" without a socket
 * round-trip. This endpoint is discovery only — no gameplay passes through it.
 */
@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get(':code')
  @ApiOperation({
    summary: 'Resolve a room code before opening its socket',
    description:
      'Public — no auth required, and deliberately minimal (no player names ' +
      'or game state, since a 4-character code is guessable in principle). ' +
      'Once resolved, connect to the returned `game`’s Socket.IO namespace ' +
      '(e.g. `/heist`) and emit `room:join` — see docs/SOCKET_EVENTS.md.',
  })
  lookup(@Param('code') code: string): RoomLookup {
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
