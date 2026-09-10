import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';

/**
 * Real-socket coverage for the 2v2 ("Squads") room-fill-to-round-start path.
 * `rooms.e2e-spec.ts` and `heist.gateway.spec.ts` only ever exercised 1v1 —
 * this fills that gap, including a concurrent-join case (four friends
 * clicking an invite link at roughly the same moment isn't hypothetical),
 * since a fake-socket unit test can't catch a real Socket.IO room-membership
 * timing issue.
 */
describe('Squads (2v2) (e2e)', () => {
  let app: INestApplication;
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
    baseUrl = url.replace('[::1]', '127.0.0.1').replace('::1', '127.0.0.1');
  });

  afterAll(async () => {
    for (const socket of openSockets) socket.disconnect();
    await app.close();
  });

  function connect(): Socket {
    const socket = io(`${baseUrl}/heist`, {
      transports: ['websocket'],
      forceNew: true,
    });
    openSockets.push(socket);
    return socket;
  }

  function once<T>(
    socket: Socket,
    event: string,
    timeoutMs = 8000,
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

  it('starts the round for every seat once all 4 join, one at a time', async () => {
    const host = connect();
    const created = once<{ roomCode: string }>(host, 'room:created');
    host.emit('room:create', {
      playerId: 'seq-1',
      displayName: 'Ana',
      mode: '2v2',
    });
    const { roomCode } = await created;

    const hostState = once<{ status: string }>(host, 'heist:state');

    const p2 = connect();
    await Promise.all([
      once(p2, 'room:joined'),
      (async () =>
        p2.emit('room:join', {
          roomCode,
          playerId: 'seq-2',
          displayName: 'Ben',
        }))(),
    ]);

    const p3 = connect();
    await Promise.all([
      once(p3, 'room:joined'),
      (async () =>
        p3.emit('room:join', {
          roomCode,
          playerId: 'seq-3',
          displayName: 'Cal',
        }))(),
    ]);

    const p4 = connect();
    const p4Joined = once<{ players: unknown[] }>(p4, 'room:joined');
    const p4State = once<{ status: string }>(p4, 'heist:state');
    p4.emit('room:join', { roomCode, playerId: 'seq-4', displayName: 'Dee' });
    const joinPayload = await p4Joined;
    expect(joinPayload.players).toHaveLength(4);

    const [hostResult, p4Result] = await Promise.all([hostState, p4State]);
    expect(hostResult.status).toBe('playing');
    expect(p4Result.status).toBe('playing');
  }, 15000);

  it('starts the round when all 3 remaining seats join in the same tick', async () => {
    const host = connect();
    const created = once<{ roomCode: string }>(host, 'room:created');
    host.emit('room:create', {
      playerId: 'con-1',
      displayName: 'Ana',
      mode: '2v2',
    });
    const { roomCode } = await created;

    const hostState = once<{ status: string }>(host, 'heist:state');
    const guests = [connect(), connect(), connect()];
    const joins = guests.map((s) => once<{ players: unknown[] }>(s, 'room:joined'));
    const states = guests.map((s) => once<{ status: string }>(s, 'heist:state'));

    guests[0].emit('room:join', {
      roomCode,
      playerId: 'con-2',
      displayName: 'Ben',
    });
    guests[1].emit('room:join', {
      roomCode,
      playerId: 'con-3',
      displayName: 'Cal',
    });
    guests[2].emit('room:join', {
      roomCode,
      playerId: 'con-4',
      displayName: 'Dee',
    });

    await Promise.all(joins);
    const results = await Promise.all([hostState, ...states]);
    for (const r of results) expect(r.status).toBe('playing');
  }, 15000);
});
