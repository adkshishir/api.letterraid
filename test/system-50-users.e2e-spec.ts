import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HEIST_DICTIONARY_RAW } from '../src/heist/heist.dictionary';
import { canSpell, letterCounts, MIN_WORD_LENGTH, ROUND_DURATION_MS } from '../src/heist/heist.types';
import { BOT_TIERS } from '../src/heist/heist-bot.service';

/**
 * Full-system simulation: 50 throwaway accounts, split across every major
 * surface (profile/leaderboard browsing, clans, practice bots, ranked
 * matchmaking, tournaments — including the lobby/start flow — and 2v2
 * Squads), driving real REST calls and real Socket.IO gameplay against an
 * in-process app instance. Two things make this safe to run against the
 * live database:
 *
 *  - The app is booted fresh here (`Test.createTestingModule`), so its
 *    in-memory matchmaker/tournament queues are entirely separate from the
 *    live pm2-managed process's — a simulated player can never be paired
 *    with a real one.
 *  - Every row this test creates (players, sessions, otp codes, clans,
 *    tournaments, matches, claims) is deleted in `afterAll`, keyed off the
 *    ids collected along the way.
 *
 * OTP codes are written straight into the database rather than requested
 * through `POST /auth/request-otp`, specifically to avoid triggering 50 real
 * emails through the configured mail transport.
 */

jest.setTimeout(300_000);

const RUN_ID = Date.now();
const FULL_DURATION_MS = ROUND_DURATION_MS + 15_000;
const SHORT_DURATION_MS = 12_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Claimable-word solver ───────────────────────────────────────────────────
// Precomputed once: every dictionary word (4-8 letters, matching what a Heist
// pool can realistically spell) alongside its letter-count map, so a legal
// claim can be found for whatever the live pool currently holds.
const DICTIONARY_ENTRIES = HEIST_DICTIONARY_RAW.split(' ')
  .filter((w) => w.length >= MIN_WORD_LENGTH && w.length <= 8)
  .map((word) => ({ word, counts: letterCounts(word) }));

function findClaimableWord(pool: string[]): string | null {
  if (pool.length < MIN_WORD_LENGTH) return null;
  const poolCounts = letterCounts(pool.join('').toLowerCase());
  for (const entry of DICTIONARY_ENTRIES) {
    if (entry.word.length > pool.length) continue;
    if (canSpell(entry.counts, poolCounts)) return entry.word;
  }
  return null;
}

interface Account {
  token: string;
  player: { id: string; displayName: string };
}

interface GameOverPayload {
  scores: { playerId: string; score: number; words: number; team: number | null }[];
  winnerId: string | null;
  tied: boolean;
  teamScores: { team: number; score: number; playerIds: string[] }[] | null;
  winningTeam: number | null;
  trophyDeltas: Record<string, number> | null;
}

interface PlayStats {
  roomCode: string;
  claimed: number;
  errors: number;
  sawPlaying: boolean;
  gameOver: GameOverPayload | null;
}

describe('Full system simulation — 50 mixed-behavior users (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  const openSockets: Socket[] = [];

  const playerIds: string[] = [];
  const matchRoomCodes = new Set<string>();
  const tournamentIds = new Set<string>();
  const clanIds = new Set<string>();

  const issues: string[] = [];
  const backgroundPlays: Promise<void>[] = [];

  let accounts: Account[] = [];
  let profileGroup: Account[] = [];
  let clanGroup: Account[] = [];
  let practiceGroup: Account[] = [];
  let rankedGroup: Account[] = [];
  let tourneyGroup: Account[] = [];
  let squadGroup: Account[] = [];
  let tournamentCode = '';

  const fullResults: { ranked?: PlayStats[]; tournament?: PlayStats[]; squads?: PlayStats[] } = {};

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);
    const url = await app.getUrl();
    baseUrl = url.replace('[::1]', '127.0.0.1').replace('::1', '127.0.0.1');
    prisma = app.get(PrismaService);

    const names = [
      ...Array.from({ length: 6 }, (_, i) => `QA-Prof-${i}`),
      ...Array.from({ length: 8 }, (_, i) => `QA-Clan-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `QA-Prac-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `QA-Rank-${i}`),
      ...Array.from({ length: 12 }, (_, i) => `QA-Trny-${i}`),
      ...Array.from({ length: 4 }, (_, i) => `QA-Sqd-${i}`),
    ];
    expect(names).toHaveLength(50);

    accounts = await Promise.all(names.map((name, i) => registerPlayer(i, name)));
    for (const a of accounts) playerIds.push(a.player.id);

    profileGroup = accounts.slice(0, 6);
    clanGroup = accounts.slice(6, 14);
    practiceGroup = accounts.slice(14, 24);
    rankedGroup = accounts.slice(24, 34);
    tourneyGroup = accounts.slice(34, 46);
    squadGroup = accounts.slice(46, 50);
  }, 60_000);

  afterAll(async () => {
    for (const s of openSockets) {
      try {
        s.disconnect();
      } catch {
        // best effort
      }
    }

    try {
      if (matchRoomCodes.size) {
        await prisma.match.deleteMany({ where: { roomCode: { in: [...matchRoomCodes] } } });
      }
      if (tournamentIds.size) {
        await prisma.tournament.deleteMany({ where: { id: { in: [...tournamentIds] } } });
      }
      if (clanIds.size) {
        await prisma.clan.deleteMany({ where: { id: { in: [...clanIds] } } });
      }
      if (playerIds.length) {
        await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  // ── Helpers ────────────────────────────────────────────────────────────

  async function api(path: string, opts: RequestInit = {}, token?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string, string>) ?? {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { ...opts, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(
        `${opts.method ?? 'GET'} ${path} -> ${res.status}: ${body?.message ?? res.statusText}`,
      ) as Error & { status?: number; body?: unknown };
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async function registerPlayer(i: number, name: string): Promise<Account> {
    const email = `qa-sys-${RUN_ID}-${i}@example.test`;
    const code = String(100000 + i);
    await prisma.otpCode.create({
      data: { email, code, expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    const auth = await api('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email, code, displayName: name }),
    });
    return auth as Account;
  }

  function connectSocket(): Socket {
    const s = io(`${baseUrl}/heist`, { transports: ['websocket'], forceNew: true });
    openSockets.push(s);
    return s;
  }

  function once<T>(socket: Socket, event: string, timeoutMs = 10_000): Promise<T> {
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

  /**
   * Wires up the listeners a live auto-player needs on a socket that is
   * already (about to be) seated in `roomCode`: claims any word the pool can
   * currently spell (throttled to ~1/s), and tracks claims/errors/game-over.
   * `getRoomCode` is a thunk rather than a plain string because the creator
   * of a room doesn't know its code until after `room:create` resolves.
   */
  function attachAutoPlayListeners(socket: Socket, getRoomCode: () => string, playerId: string) {
    let claimed = 0;
    let errors = 0;
    let sawPlaying = false;
    let lastClaimAttempt = 0;
    let gameOver: GameOverPayload | null = null;

    const gameOverPromise = new Promise<void>((resolve) => {
      socket.once('heist:game-over', (payload: GameOverPayload) => {
        gameOver = payload;
        resolve();
      });
    });

    socket.on('heist:state', (state: { status: string; pool: string[] }) => {
      if (state.status === 'playing') sawPlaying = true;
      const roomCode = getRoomCode();
      const now = Date.now();
      if (!roomCode || now - lastClaimAttempt < 900) return;
      lastClaimAttempt = now;
      const word = findClaimableWord(state.pool ?? []);
      if (word) socket.emit('heist:claim', { roomCode, playerId, word });
    });
    socket.on('heist:claimed', (payload: { playerId: string }) => {
      if (payload.playerId === playerId) claimed++;
    });
    socket.on('heist:error', () => {
      errors++;
    });

    return {
      gameOverPromise,
      getStats: (): Omit<PlayStats, 'roomCode'> => ({ claimed, errors, sawPlaying, gameOver }),
    };
  }

  /** Joins an already-existing room and plays it, blocking until done/timeout. */
  async function enterAndAutoPlay(
    socket: Socket,
    entry: { roomCode: string; playerId: string; displayName: string },
    durationMs: number,
  ): Promise<PlayStats> {
    const { gameOverPromise, getStats } = attachAutoPlayListeners(
      socket,
      () => entry.roomCode,
      entry.playerId,
    );
    const joinedPromise = once(socket, 'room:joined');
    socket.emit('room:join', {
      roomCode: entry.roomCode,
      playerId: entry.playerId,
      displayName: entry.displayName,
    });
    await joinedPromise;
    socket.emit('heist:request-state', { roomCode: entry.roomCode });

    await Promise.race([gameOverPromise, sleep(durationMs)]);
    return { roomCode: entry.roomCode, ...getStats() };
  }

  /**
   * Joins a room and returns as soon as the join is confirmed — the actual
   * play-out (up to `durationMs` or game-over) is handed back as `result`,
   * a promise the caller can await later or push to background work,
   * instead of blocking the caller until the round finishes.
   */
  async function joinAndObserve(
    socket: Socket,
    entry: { roomCode: string; playerId: string; displayName: string },
    durationMs: number,
  ): Promise<{ result: Promise<PlayStats> }> {
    const { gameOverPromise, getStats } = attachAutoPlayListeners(
      socket,
      () => entry.roomCode,
      entry.playerId,
    );
    const joinedPromise = once(socket, 'room:joined');
    socket.emit('room:join', {
      roomCode: entry.roomCode,
      playerId: entry.playerId,
      displayName: entry.displayName,
    });
    await joinedPromise;
    socket.emit('heist:request-state', { roomCode: entry.roomCode });

    const result = Promise.race([gameOverPromise, sleep(durationMs)]).then(() => ({
      roomCode: entry.roomCode,
      ...getStats(),
    }));
    return { result };
  }

  /** Same split as `joinAndObserve`, but creates the room instead of joining one. */
  async function createRoomAndObserve(
    socket: Socket,
    playerId: string,
    displayName: string,
    mode: '1v1' | '2v2',
    durationMs: number,
  ): Promise<{ roomCode: string; result: Promise<PlayStats> }> {
    let roomCode = '';
    const { gameOverPromise, getStats } = attachAutoPlayListeners(socket, () => roomCode, playerId);

    const createdPromise = once<{ roomCode: string }>(socket, 'room:created');
    socket.emit('room:create', { playerId, displayName, mode });
    roomCode = (await createdPromise).roomCode;
    socket.emit('heist:request-state', { roomCode });

    const result = Promise.race([gameOverPromise, sleep(durationMs)]).then(() => ({
      roomCode,
      ...getStats(),
    }));
    return { roomCode, result };
  }

  async function pairForRankedMatch(a: Account, b: Account): Promise<string> {
    await Promise.all([
      api('/match/queue', { method: 'POST' }, a.token),
      api('/match/queue', { method: 'POST' }, b.token),
    ]);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { match } = await api('/match/active', {}, a.token);
      if (match) return match.roomCode;
      await sleep(500);
    }
    throw new Error(`ranked pairing timed out for ${a.player.displayName}/${b.player.displayName}`);
  }

  async function pairForTournamentMatch(
    code: string,
    a: Account,
    b: Account,
  ): Promise<string> {
    await Promise.all([
      api(`/tournaments/${code}/queue`, { method: 'POST' }, a.token),
      api(`/tournaments/${code}/queue`, { method: 'POST' }, b.token),
    ]);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { match } = await api(`/tournaments/${code}/active`, {}, a.token);
      if (match) return match.roomCode;
      await sleep(500);
    }
    throw new Error(
      `tournament pairing timed out for ${a.player.displayName}/${b.player.displayName}`,
    );
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  it('profile and leaderboard browsing works for every player in the group', async () => {
    for (const acc of profileGroup) {
      const me = await api('/auth/me', {}, acc.token);
      expect(me.id).toBe(acc.player.id);

      const renamed = await api(
        '/auth/profile',
        { method: 'PUT', body: JSON.stringify({ displayName: `${acc.player.displayName}-2` }) },
        acc.token,
      );
      expect(renamed.displayName).toBe(`${acc.player.displayName}-2`);

      const top = await api('/leaderboard?limit=10', {}, acc.token);
      expect(Array.isArray(top)).toBe(true);

      const myRank = await api('/leaderboard/me', {}, acc.token);
      expect(typeof myRank.trophies).toBe('number');
      expect(typeof myRank.rank).toBe('number');
    }
  }, 30_000);

  it('clan create/join/roster/leave works for two clans of four', async () => {
    const [leaderA, m1, m2, m3, leaderB, m4, m5, m6] = clanGroup;

    const clanA = await api(
      '/clans',
      { method: 'POST', body: JSON.stringify({ name: `QA Clan A ${RUN_ID}` }) },
      leaderA.token,
    );
    clanIds.add(clanA.id);
    for (const member of [m1, m2, m3]) {
      await api(`/clans/${clanA.id}/join`, { method: 'POST' }, member.token);
    }

    const clanADetail = await api(`/clans/${clanA.id}`, {}, leaderA.token);
    const rosterA = clanADetail.roster ?? clanADetail.members;
    expect(rosterA).toHaveLength(4);
    expect(clanADetail.myRole).toBe('LEADER');

    const mine = await api('/clans/me', {}, m1.token);
    expect(mine?.id).toBe(clanA.id);

    // m3 leaves; roster should drop to 3.
    await api('/clans/leave', { method: 'POST' }, m3.token);
    const afterLeave = await api(`/clans/${clanA.id}`, {}, leaderA.token);
    const rosterAfter = afterLeave.roster ?? afterLeave.members;
    expect(rosterAfter).toHaveLength(3);

    const clanB = await api(
      '/clans',
      { method: 'POST', body: JSON.stringify({ name: `QA Clan B ${RUN_ID}` }) },
      leaderB.token,
    );
    clanIds.add(clanB.id);
    for (const member of [m4, m5, m6]) {
      await api(`/clans/${clanB.id}/join`, { method: 'POST' }, member.token);
    }

    const publicList = await api('/clans?limit=50');
    const ids = (publicList as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([clanA.id, clanB.id]));
  }, 30_000);

  it('practice matches against bots connect and let players claim words', async () => {
    const results = await Promise.all(
      practiceGroup.map(async (acc, i) => {
        const tier = BOT_TIERS[i % BOT_TIERS.length];
        const match = await api(
          '/practice/start',
          { method: 'POST', body: JSON.stringify({ tier }) },
          acc.token,
        );
        const socket = connectSocket();
        const stats = await enterAndAutoPlay(
          socket,
          { roomCode: match.roomCode, playerId: acc.player.id, displayName: acc.player.displayName },
          SHORT_DURATION_MS,
        );
        socket.disconnect();
        return stats;
      }),
    );

    const sawPlayingCount = results.filter((r) => r.sawPlaying).length;
    if (sawPlayingCount < practiceGroup.length) {
      issues.push(
        `Practice: only ${sawPlayingCount}/${practiceGroup.length} rooms reached "playing" ` +
          `state within ${SHORT_DURATION_MS}ms.`,
      );
    }
    expect(sawPlayingCount).toBeGreaterThanOrEqual(Math.ceil(practiceGroup.length * 0.8));
  }, 40_000);

  it('ranked matchmaking pairs players into real 1v1 rooms', async () => {
    const pairs: [Account, Account][] = [];
    for (let i = 0; i < rankedGroup.length; i += 2) {
      pairs.push([rankedGroup[i], rankedGroup[i + 1]]);
    }

    // Pairing itself stays sequential — the ranked queue is one shared FIFO,
    // so queueing two pairs concurrently risks the matchmaker crossing them
    // (a matched with c instead of b). Only the post-match observation
    // window runs in parallel across pairs, which is what actually costs
    // wall-clock time.
    const shortPairChecks: Promise<void>[] = [];

    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i];
      const roomCode = await pairForRankedMatch(a, b);
      matchRoomCodes.add(roomCode);

      const socketA = connectSocket();
      const socketB = connectSocket();

      if (i === 0) {
        // The one pair we watch all the way to a natural finish.
        const [obsA, obsB] = await Promise.all([
          joinAndObserve(
            socketA,
            { roomCode, playerId: a.player.id, displayName: a.player.displayName },
            FULL_DURATION_MS,
          ),
          joinAndObserve(
            socketB,
            { roomCode, playerId: b.player.id, displayName: b.player.displayName },
            FULL_DURATION_MS,
          ),
        ]);
        backgroundPlays.push(
          Promise.all([obsA.result, obsB.result]).then(([ra, rb]) => {
            fullResults.ranked = [ra, rb];
          }),
        );
      } else {
        const [obsA, obsB] = await Promise.all([
          joinAndObserve(
            socketA,
            { roomCode, playerId: a.player.id, displayName: a.player.displayName },
            SHORT_DURATION_MS,
          ),
          joinAndObserve(
            socketB,
            { roomCode, playerId: b.player.id, displayName: b.player.displayName },
            SHORT_DURATION_MS,
          ),
        ]);
        shortPairChecks.push(
          Promise.all([obsA.result, obsB.result]).then(([ra, rb]) => {
            if (!ra.sawPlaying || !rb.sawPlaying) {
              issues.push(`Ranked pair ${i} (room ${roomCode}) never reached "playing" state.`);
            }
            socketA.disconnect();
            socketB.disconnect();
          }),
        );
      }
    }

    await Promise.all(shortPairChecks);
  }, 60_000);

  it('tournament lobby/start flow works at scale and pairs matches', async () => {
    const [host, ...joiners] = tourneyGroup;

    const created = await api(
      '/tournaments',
      {
        method: 'POST',
        body: JSON.stringify({ name: `QA System Test ${RUN_ID}`, maxMembers: 50, durationMin: 30 }),
      },
      host.token,
    );
    tournamentIds.add(created.id);
    tournamentCode = created.code;
    expect(created.status).toBe('LOBBY');
    expect(created.endsAt).toBeNull();

    for (const j of joiners) {
      await api(`/tournaments/${created.code}/join`, { method: 'POST' }, j.token);
    }

    const beforeStart = await api(`/tournaments/${created.code}`, {}, host.token);
    expect(beforeStart.memberCount).toBe(12);

    // Exactly the scenario this feature was built for: 12 joined out of a
    // cap of 50, host starts anyway rather than waiting for the room to fill.
    const started = await api(`/tournaments/${created.code}/start`, { method: 'POST' }, host.token);
    expect(started.status).toBe('OPEN');
    expect(started.endsAt).not.toBeNull();

    const all = [host, ...joiners];
    const pairs: [Account, Account][] = [];
    for (let i = 0; i < all.length; i += 2) {
      pairs.push([all[i], all[i + 1]]);
    }

    // Same reasoning as the ranked test: pairing is sequential (one shared
    // tournament queue), observation runs in parallel across pairs.
    const shortPairChecks: Promise<void>[] = [];

    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i];
      const roomCode = await pairForTournamentMatch(created.code, a, b);
      matchRoomCodes.add(roomCode);

      const socketA = connectSocket();
      const socketB = connectSocket();

      if (i === 0) {
        const [obsA, obsB] = await Promise.all([
          joinAndObserve(
            socketA,
            { roomCode, playerId: a.player.id, displayName: a.player.displayName },
            FULL_DURATION_MS,
          ),
          joinAndObserve(
            socketB,
            { roomCode, playerId: b.player.id, displayName: b.player.displayName },
            FULL_DURATION_MS,
          ),
        ]);
        backgroundPlays.push(
          Promise.all([obsA.result, obsB.result]).then(([ra, rb]) => {
            fullResults.tournament = [ra, rb];
          }),
        );
      } else {
        const [obsA, obsB] = await Promise.all([
          joinAndObserve(
            socketA,
            { roomCode, playerId: a.player.id, displayName: a.player.displayName },
            SHORT_DURATION_MS,
          ),
          joinAndObserve(
            socketB,
            { roomCode, playerId: b.player.id, displayName: b.player.displayName },
            SHORT_DURATION_MS,
          ),
        ]);
        shortPairChecks.push(
          Promise.all([obsA.result, obsB.result]).then(([ra, rb]) => {
            if (!ra.sawPlaying || !rb.sawPlaying) {
              issues.push(`Tournament pair ${i} (room ${roomCode}) never reached "playing" state.`);
            }
            socketA.disconnect();
            socketB.disconnect();
          }),
        );
      }
    }

    await Promise.all(shortPairChecks);
  }, 90_000);

  it('a 2v2 Squads room fills and starts a real round', async () => {
    const [p1, p2, p3, p4] = squadGroup;
    const s1 = connectSocket();
    const s2 = connectSocket();
    const s3 = connectSocket();
    const s4 = connectSocket();

    const { roomCode, result: r1 } = await createRoomAndObserve(
      s1,
      p1.player.id,
      p1.player.displayName,
      '2v2',
      FULL_DURATION_MS,
    );
    const { result: r2 } = await joinAndObserve(
      s2,
      { roomCode, playerId: p2.player.id, displayName: p2.player.displayName },
      FULL_DURATION_MS,
    );
    const { result: r3 } = await joinAndObserve(
      s3,
      { roomCode, playerId: p3.player.id, displayName: p3.player.displayName },
      FULL_DURATION_MS,
    );
    const { result: r4 } = await joinAndObserve(
      s4,
      { roomCode, playerId: p4.player.id, displayName: p4.player.displayName },
      FULL_DURATION_MS,
    );

    backgroundPlays.push(
      Promise.all([r1, r2, r3, r4]).then((results) => {
        fullResults.squads = results;
      }),
    );
  }, 20_000);

  it('ranked and tournament matches finish naturally and update real stats', async () => {
    await Promise.all(backgroundPlays);

    // ── Ranked pair: trophies must move, match history must show it.
    const ranked = fullResults.ranked;
    expect(ranked).toBeDefined();
    if (ranked) {
      const [ra, rb] = ranked;
      if (!ra.gameOver || !rb.gameOver) {
        issues.push(`Ranked full match (room ${ra.roomCode}) never received heist:game-over.`);
      } else {
        expect(ra.gameOver.trophyDeltas).not.toBeNull();
      }
    }

    // ── Squads: no Match row, no trophy movement — it's outside the ranked pipeline.
    const squads = fullResults.squads;
    expect(squads).toBeDefined();
    if (squads) {
      const missingGameOver = squads.filter((r) => !r.gameOver).length;
      if (missingGameOver > 0) {
        issues.push(`Squads: ${missingGameOver}/4 players never received heist:game-over.`);
      }
      const withTeams = squads.find((r) => r.gameOver);
      if (withTeams?.gameOver) {
        expect(withTeams.gameOver.teamScores).not.toBeNull();
        expect(withTeams.gameOver.trophyDeltas).toBeNull();
      }
    }

    // Give the DB a moment to settle for matches that finished via the
    // server's own round timer after we'd already disconnected (the
    // "abandoned but still completes" pairs).
    await sleep(2_000);

    let completedRankedMatches = 0;
    for (let i = 0; i < rankedGroup.length; i += 2) {
      const a = rankedGroup[i];
      const history = await api('/match/history?limit=10', {}, a.token);
      if ((history.matches ?? history).length > 0) completedRankedMatches++;
    }
    if (completedRankedMatches < 5) {
      issues.push(
        `Only ${completedRankedMatches}/5 ranked pairs show a completed match in history ` +
          `after the round should have ended.`,
      );
    }

    // ── Tournament: standings should reflect every pair's finished match.
    const tournamentDetail = await api(`/tournaments/${tournamentCode}`, {}, tourneyGroup[0].token);
    const playedStandings = (tournamentDetail.standings as { wins: number; losses: number }[]).filter(
      (s) => s.wins + s.losses > 0,
    );
    if (playedStandings.length < 12) {
      issues.push(
        `Tournament standings show only ${playedStandings.length}/12 participants with a ` +
          `recorded result after their matches should have ended.`,
      );
    }

    if (issues.length > 0) {
      // eslint-disable-next-line no-console
      console.error('System test found issues:\n' + issues.map((s) => ` - ${s}`).join('\n'));
    }
    expect(issues).toEqual([]);
  }, 240_000);
});
