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
import { GameId, maxPlayersForMode } from '../rooms/room.types';
import { HeistService } from './heist.service';
import { HeistResultsService } from './heist-results.service';
import { HeistBotService } from './heist-bot.service';
import { HeistError, ROUND_DURATION_MS } from './heist.types';
import { TournamentsService } from '../tournaments/tournaments.service';
import { PracticeService } from './practice.service';

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
    private readonly results: HeistResultsService,
    private readonly bot: HeistBotService,
    private readonly tournaments: TournamentsService,
    private readonly practice: PracticeService,
  ) {
    super(rooms);
  }

  onModuleDestroy() {
    for (const code of [...this.clocks.keys()]) {
      this.bot.stopBot(code);
      this.stopClocks(code);
    }
  }

  // ── Room hooks ────────────────────────────────────────────────────────────

  protected override onPlayerReady(roomCode: string, playerId: string): void {
    const room = this.rooms.getRoom(roomCode);
    if (!room) return;

    // Never start early: a 1v1 room needs 2 players in the seats, a 2v2 room
    // needs all 4 — a race that starts before every runner is on the line
    // isn't one.
    if (room.players.length >= maxPlayersForMode(room.mode)) {
      const started = this.heist.ensureGame(
        roomCode,
        room.players.map((p) => ({ id: p.id, team: p.team })),
      );
      if (started && !this.clocks.has(roomCode)) {
        this.startClocks(roomCode);
        // Practice rooms never touch the ranked pipeline — see `PracticeService`.
        if (!this.practice.isPractice(roomCode)) {
          this.results.startMatch(roomCode, started.playerIds).catch(() => {});
        }
        this.maybeStartBot(roomCode);
      }
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
    this.bot.stopBot(roomCode);
    this.stopClocks(roomCode);
    this.heist.clear(roomCode);
    this.results.discard(roomCode);
    this.practice.clear(roomCode);
  }

  // ── Heist events ──────────────────────────────────────────────────────────

  @SubscribeMessage('heist:claim')
  handleClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: HeistPayload,
  ) {
    const roomCode = asString(data?.roomCode);
    const playerId = asString(data?.playerId);
    const word = asString(data?.word);

    this.guard(client, () => this.performClaim(roomCode, playerId, word));
  }

  /**
   * The one path a claim takes, whether it came from a real client's
   * `heist:claim` or a bot's think loop (see `maybeStartBot`) — so a bot's
   * claims are indistinguishable downstream from a human's: same engine call,
   * same persistence, same broadcast. Throws `HeistError` on an illegal claim,
   * exactly like `HeistService.claim` — callers decide what that means for
   * them (a socket error for a human, a silent whiff for a bot).
   */
  private performClaim(roomCode: string, playerId: string, word: string) {
    const outcome = this.heist.claim(roomCode, playerId, word);
    this.rooms.touch(roomCode);
    this.results.recordClaim(roomCode, outcome).catch(() => {});

    this.emitToRoom(roomCode, 'heist:claimed', {
      playerId: outcome.playerId,
      word: outcome.word,
      points: outcome.points,
      type: outcome.type,
      stolenWord: outcome.stolenWord,
      stolenFrom: outcome.stolenFrom,
    });
    this.pushState(roomCode);
  }

  @SubscribeMessage('heist:restart')
  handleRestart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: HeistPayload,
  ) {
    const roomCode = asString(data?.roomCode);

    this.guard(client, () => {
      const room = this.rooms.getRoom(roomCode);
      const players = (room?.players ?? []).map((p) => ({
        id: p.id,
        team: p.team,
      }));
      this.heist.restart(roomCode, players);
      this.rooms.touch(roomCode);

      this.emitToRoom(roomCode, 'heist:restarted', {});
      this.startClocks(roomCode);
      this.maybeStartBot(roomCode);
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
    }, this.heist.letterIntervalMs(roomCode));

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

  private async endRound(roomCode: string) {
    this.bot.stopBot(roomCode);
    this.stopClocks(roomCode);

    const result = this.heist.finish(roomCode);
    if (!result) return;

    // No-op for every room that isn't a tournament match — see
    // `TournamentsService.recordResult`.
    this.tournaments.recordResult(roomCode, result);

    // Practice rooms never touch the ranked pipeline — see `PracticeService`.
    const trophyDeltas = this.practice.isPractice(roomCode)
      ? null
      : await this.results.finishMatch(roomCode, result);

    this.emitToRoom(roomCode, 'heist:game-over', {
      scores: result.scores,
      winnerId: result.winnerId,
      tied: result.tied,
      teamScores: result.teamScores,
      winningTeam: result.winningTeam,
      trophyDeltas,
    });
    this.pushState(roomCode);
  }

  // ── Bot ───────────────────────────────────────────────────────────────────

  /**
   * Starts the bot's think loop when this room has a bot seat — a no-op for
   * every ordinary human-vs-human room. Called once a round actually starts,
   * from both `onPlayerReady` (fresh round) and `handleRestart` (rematch).
   *
   * A practice room (see `PracticeService`) uses the tier the player
   * explicitly chose; every other bot seat — the ranked matchmaker's
   * fallback — is tuned off the human's live trophies, stashed on the
   * in-memory room player by `MatchmakerService.createBotMatch` (see the doc
   * comment on `Player.trophies` in `room.types.ts` for why that's where it
   * lives rather than a fresh DB read here).
   */
  private maybeStartBot(roomCode: string): void {
    const room = this.rooms.getRoom(roomCode);
    if (!room) return;

    const botPlayer = room.players.find((p) => p.isBot);
    if (!botPlayer) return;

    const claimFn = (playerId: string, word: string) => {
      try {
        this.performClaim(roomCode, playerId, word);
      } catch {
        // A whiff — same as a human's failed claim. Nothing further to do;
        // the bot's next think is already scheduled.
      }
    };

    const practiceTier = this.practice.tierFor(roomCode);
    if (practiceTier) {
      this.bot.startPracticeBot(roomCode, botPlayer.id, practiceTier, claimFn);
      return;
    }

    const human = room.players.find((p) => !p.isBot);
    const humanTrophies = human?.trophies ?? 0;
    this.bot.startBot(roomCode, botPlayer.id, humanTrophies, claimFn);
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
