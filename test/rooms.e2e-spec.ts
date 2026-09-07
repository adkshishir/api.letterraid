import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { io, Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { GameId } from './../src/rooms/room.types';

/**
 * Exercises the real Socket.io stack rather than calling the service directly.
 *
 * The specific thing this protects: `BaseRoomGateway` declares the `room:*`
 * handlers and each game gateway only subclasses it. Whether Nest picks up
 * inherited `@SubscribeMessage` decorators is a framework detail — if it ever
 * stops working, every unit test still passes and the app is silently dead.
 */
describe('Rooms (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  const openSockets: Socket[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);

    const url = await app.getUrl();
    // getUrl() reports IPv6 :: on some hosts, which the client can't dial.
    baseUrl = url.replace('[::1]', '127.0.0.1').replace('::1', '127.0.0.1');
  });

  afterAll(async () => {
    for (const socket of openSockets) socket.disconnect();
    await app.close();
  });

  function connect(namespace: GameId): Socket {
    const socket = io(`${baseUrl}/${namespace}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    openSockets.push(socket);
    return socket;
  }

  function once<T>(
    socket: Socket,
    event: string,
    timeoutMs = 4000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${event}"`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  async function createRoom(
    namespace: GameId,
    playerId: string,
    displayName: string,
  ) {
    const socket = connect(namespace);
    const created = once<{ roomCode: string }>(socket, 'room:created');
    socket.emit('room:create', { playerId, displayName });
    return { socket, ...(await created) };
  }

  it('creates a room and returns a code', async () => {
    const { roomCode } = await createRoom('heist', 'p1', 'Ana');
    expect(roomCode).toMatch(/^[A-Z2-9]{4}$/);
  });

  it('lets a second player join and notifies the first', async () => {
    const { socket: hostSocket, roomCode } = await createRoom(
      'heist',
      'host-1',
      'Ana',
    );

    const hostNotified = once<{ player: { displayName: string } }>(
      hostSocket,
      'room:player-joined',
    );

    const guestSocket = connect('heist');
    const joined = once<{ players: unknown[]; reconnected: boolean }>(
      guestSocket,
      'room:joined',
    );
    guestSocket.emit('room:join', {
      roomCode,
      playerId: 'guest-1',
      displayName: 'Ben',
    });

    const joinResult = await joined;
    expect(joinResult.players).toHaveLength(2);
    expect(joinResult.reconnected).toBe(false);

    const notification = await hostNotified;
    expect(notification.player.displayName).toBe('Ben');
  });

  it('rejects a third player as ROOM_FULL', async () => {
    const { roomCode } = await createRoom('heist', 'host-2', 'Ana');

    const guest = connect('heist');
    const guestJoined = once(guest, 'room:joined');
    guest.emit('room:join', {
      roomCode,
      playerId: 'guest-2',
      displayName: 'Ben',
    });
    await guestJoined;

    const third = connect('heist');
    const error = once<{ code: string }>(third, 'room:error');
    third.emit('room:join', {
      roomCode,
      playerId: 'third-1',
      displayName: 'Cal',
    });

    expect((await error).code).toBe('ROOM_FULL');
  });

  it('reports an unknown room code', async () => {
    const socket = connect('heist');
    const error = once<{ code: string }>(socket, 'room:error');
    socket.emit('room:join', {
      roomCode: 'ZZZZ',
      playerId: 'p',
      displayName: 'Ana',
    });
    expect((await error).code).toBe('ROOM_NOT_FOUND');
  });

  it('rejects a profane display name', async () => {
    const socket = connect('heist');
    const error = once<{ code: string }>(socket, 'room:error');
    socket.emit('room:create', { playerId: 'p', displayName: 'fuck' });
    expect((await error).code).toBe('PROFANITY_REJECTED');
  });

  it('tells the remaining player when their partner drops', async () => {
    const { socket: hostSocket, roomCode } = await createRoom(
      'heist',
      'host-3',
      'Ana',
    );

    const guest = connect('heist');
    const guestJoined = once(guest, 'room:joined');
    guest.emit('room:join', {
      roomCode,
      playerId: 'guest-3',
      displayName: 'Ben',
    });
    await guestJoined;

    const left = once<{ playerId: string; temporary: boolean }>(
      hostSocket,
      'room:player-left',
    );
    guest.disconnect();

    const result = await left;
    expect(result.playerId).toBe('guest-3');
    // A dropped connection is temporary — the seat is held for a return.
    expect(result.temporary).toBe(true);
  });

  it('restores a returning player into their existing seat', async () => {
    const { socket: hostSocket, roomCode } = await createRoom(
      'heist',
      'host-4',
      'Ana',
    );
    hostSocket.disconnect();

    const returning = connect('heist');
    const rejoined = once<{ players: unknown[]; reconnected: boolean }>(
      returning,
      'room:joined',
    );
    returning.emit('room:join', {
      roomCode,
      playerId: 'host-4',
      displayName: 'Ana',
    });

    const result = await rejoined;
    expect(result.reconnected).toBe(true);
    // Crucially still one player — a reconnect must not consume a second seat.
    expect(result.players).toHaveLength(1);
  });

  it('keeps every game in one namespace-agnostic registry', async () => {
    // A `/room/CODE` share link doesn't name the game, so the lookup endpoint
    // is what tells the page which namespace to open. One game today, but the
    // registry is what makes adding a second one free.
    const { roomCode } = await createRoom('heist', 'lookup-1', 'Ana');

    const res = await request(app.getHttpServer())
      .get(`/rooms/${roomCode}`)
      .expect(200);

    expect(res.body).toEqual({
      code: roomCode,
      game: 'heist',
      mode: '1v1',
      playerCount: 1,
      maxPlayers: 2,
      joinable: true,
    });
  });

  it('404s the lookup for an unknown code', async () => {
    await request(app.getHttpServer()).get('/rooms/ZZZZ').expect(404);
  });
});
