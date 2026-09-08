import { HeistService } from './heist.service';
import {
  HeistError,
  HeistGame,
  MIN_WORD_LENGTH,
  canSpell,
  isSuffixSteal,
  letterCounts,
  remainder,
  wordPoints,
} from './heist.types';

const ROOM = 'AB2C';
const ANA = 'ana';
const BEN = 'ben';

/** 1v1 games have no teams — every player's `team` is null. */
const solo = (...ids: string[]) => ids.map((id) => ({ id, team: null }));

describe('HeistService', () => {
  let service: HeistService;
  let game: HeistGame;
  let clock: number;

  beforeEach(() => {
    service = new HeistService();
    clock = 1_000_000;
    service.ensureGame(ROOM, solo(ANA, BEN), clock);
    game = service.getGame(ROOM)!;
  });

  /** Claims always step the clock past the rate limit unless asked not to. */
  const claim = (playerId: string, word: string, step = 1000) => {
    clock += step;
    return service.claim(ROOM, playerId, word, clock);
  };

  const setPool = (letters: string) => {
    game.pool = [...letters];
  };

  const expectCode = (fn: () => unknown, code: string) => {
    try {
      fn();
      throw new Error(`expected HeistError ${code}`);
    } catch (err) {
      expect((err as HeistError).code).toBe(code);
    }
  };

  const wordsOf = (playerId: string) =>
    game.words.filter((w) => w.ownerId === playerId).map((w) => w.word);

  describe('the dictionary', () => {
    it('loads tens of thousands of words', () => {
      expect(service.dictionarySize).toBeGreaterThan(40_000);
    });

    it.each(['canoe', 'oyster', 'thrill', 'jazz', 'quiet'])(
      'knows %s',
      (word) => expect(service.isWord(word)).toBe(true),
    );

    it.each(['zzzz', 'qwertyu', 'asdfg'])('rejects %s', (word) =>
      expect(service.isWord(word)).toBe(false),
    );

    it('leaves out what the profanity filter flags', () => {
      // Dropped at generation time rather than warned about mid-race — see the
      // note in scripts/build-dictionary.mjs.
      expect(service.isWord('shit')).toBe(false);
    });
  });

  describe('scoring', () => {
    it.each([
      ['star', 1],
      ['stare', 2],
      ['stared', 3],
      ['strained', 5],
    ])('scores %s as %i', (word, points) => {
      expect(wordPoints(word)).toBe(points);
    });
  });

  describe('letter helpers', () => {
    it('finds what a word adds to another', () => {
      expect(remainder('coast', 'cat')?.sort()).toEqual(['o', 's']);
    });

    it('returns nothing when the base doesn’t fit', () => {
      expect(remainder('coast', 'dog')).toBeNull();
    });

    it('spots a single letter tacked on the end', () => {
      expect(isSuffixSteal('canoes', 'canoe')).toBe(true);
      expect(isSuffixSteal('canoeing', 'canoe')).toBe(false);
      expect(isSuffixSteal('ocean', 'canoe')).toBe(false);
    });
  });

  describe('starting a round', () => {
    it('will not start with one player', () => {
      const lonely = new HeistService();
      expect(lonely.ensureGame('ZZZZ', solo(ANA))).toBeNull();
    });

    it('deals an opening pool and starts the clock', () => {
      expect(game.pool).toHaveLength(8);
      expect(game.status).toBe('playing');
      expect(service.getState(ROOM, clock)!.msRemaining).toBe(180_000);
    });

    it('never opens on a pool nobody can spell out of', () => {
      for (let i = 0; i < 200; i++) {
        const fresh = new HeistService();
        fresh.ensureGame('ZZ' + i, solo(ANA, BEN));
        const pool = fresh.getGame('ZZ' + i)!.pool;
        expect(
          pool.filter((l) => 'aeiou'.includes(l)).length,
        ).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('claiming from the pool', () => {
    beforeEach(() => setPool('canoetsr'));

    it('takes the word and spends the letters', () => {
      const outcome = claim(ANA, 'canoe');
      expect(outcome.type).toBe('pool');
      expect(outcome.points).toBe(2);
      expect(wordsOf(ANA)).toEqual(['canoe']);
      expect(game.pool.sort()).toEqual(['r', 's', 't']);
    });

    it('is case-insensitive and trims', () => {
      expect(claim(ANA, '  CANOE ').word).toBe('canoe');
    });

    it.each(['cat', 'a', ''])('rejects %p as too short', (word) => {
      expectCode(() => claim(ANA, word), 'TOO_SHORT');
    });

    it('rejects a non-word', () => {
      setPool('ctsnaoe');
      expectCode(() => claim(ANA, 'ctsn'), 'NOT_A_WORD');
    });

    it('rejects a word the table can’t spell', () => {
      setPool('canoe');
      expectCode(() => claim(ANA, 'zebra'), 'LETTERS_UNAVAILABLE');
    });

    it('respects letter multiplicity', () => {
      setPool('caot'); // one 'o'
      expectCode(() => claim(ANA, 'coot'), 'LETTERS_UNAVAILABLE');
    });

    it('rate-limits a burst from one player', () => {
      setPool('canoetsrle');
      claim(ANA, 'canoe');
      expectCode(() => claim(ANA, 'rest', 10), 'RATE_LIMITED');
    });

    it('doesn’t let one player’s burst block the other', () => {
      setPool('canoetsrle');
      claim(ANA, 'canoe');
      expect(() => claim(BEN, 'rest', 10)).not.toThrow();
    });
  });

  describe('stealing', () => {
    it('takes a word off the other player', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      game.nextWordId = 2;
      setPool('ist');

      const outcome = claim(ANA, 'canoeist');
      expect(outcome.type).toBe('steal');
      expect(outcome.stolenWord).toBe('canoe');
      expect(outcome.stolenFrom).toBe(BEN);
      expect(wordsOf(BEN)).toEqual([]);
      expect(wordsOf(ANA)).toEqual(['canoeist']);
    });

    it('spends only the letters the steal adds', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      setPool('istx');
      claim(ANA, 'canoeist');
      // The stolen word's own letters come with it; only i, s and t are spent.
      expect(game.pool).toEqual(['x']);
    });

    it('rejects one letter tacked on the end', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      setPool('s');
      expectCode(() => claim(ANA, 'canoes'), 'SUFFIX_STEAL');
      expect(wordsOf(BEN)).toEqual(['canoe']);
    });

    it('allows the same letter when the word is reworked', () => {
      game.words = [{ id: 1, word: 'lion', ownerId: BEN }];
      setPool('s');
      // Same single letter, but the result isn't `lion` with an s on the end.
      expect(claim(ANA, 'loins').type).toBe('steal');
      expect(wordsOf(BEN)).toEqual([]);
    });

    it('lets a player rework their own word', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: ANA }];
      setPool('ist');
      const outcome = claim(ANA, 'canoeist');
      expect(outcome.stolenFrom).toBe(ANA);
      expect(wordsOf(ANA)).toEqual(['canoeist']);
    });

    it('prefers the opponent’s word to the claimer’s own', () => {
      game.words = [
        { id: 1, word: 'cane', ownerId: ANA },
        { id: 2, word: 'ocean', ownerId: BEN },
      ];
      game.nextWordId = 3;
      // `canoes` is a legal steal off either word with these letters; taking
      // Ben's is worth more to Ana, so that's the reading the server picks.
      setPool('os');
      const outcome = claim(ANA, 'canoes');
      expect(outcome.stolenFrom).toBe(BEN);
      expect(outcome.stolenWord).toBe('ocean');
      expect(wordsOf(ANA).sort()).toEqual(['cane', 'canoes']);
    });

    it('prefers the opponent’s longest word', () => {
      game.words = [
        { id: 1, word: 'ails', ownerId: BEN },
        { id: 2, word: 'trails', ownerId: BEN },
      ];
      game.nextWordId = 3;
      // Enough letters for either steal, so the choice is the rule's and not
      // the pool's.
      setPool('errt');
      const outcome = claim(ANA, 'trailers');
      expect(outcome.stolenWord).toBe('trails');
      expect(wordsOf(BEN)).toEqual(['ails']);
    });

    it('prefers a steal to a plain pool claim', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      game.nextWordId = 2;
      setPool('canoeist');
      // Ana could spell `canoeist` from the pool alone; taking Ben's word
      // instead costs her fewer letters and him a scoring word.
      const outcome = claim(ANA, 'canoeist');
      expect(outcome.type).toBe('steal');
      expect(game.pool.sort()).toEqual(['a', 'c', 'e', 'n', 'o']);
    });

    it('falls back to the pool when no steal is legal', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      game.nextWordId = 2;
      setPool('zebra');
      expect(claim(ANA, 'zebra').type).toBe('pool');
      expect(wordsOf(BEN)).toEqual(['canoe']);
    });
  });

  describe('the letter drip', () => {
    it('drops a letter onto the table', () => {
      const before = game.pool.length;
      expect(service.flipLetter(ROOM, clock)).toMatch(/^[a-z]$/);
      expect(game.pool).toHaveLength(before + 1);
    });

    it('forces a vowel when the table is starved of them', () => {
      setPool('bcdfgh');
      const letter = service.flipLetter(ROOM, clock)!;
      expect('aeiou').toContain(letter);
    });

    it('stops once the clock has run out', () => {
      expect(service.flipLetter(ROOM, game.endsAt)).toBeNull();
    });

    it('refills the bag rather than running dry', () => {
      for (let i = 0; i < 200; i++) service.flipLetter(ROOM, clock);
      expect(game.pool.length).toBeGreaterThan(100);
    });
  });

  describe('finishing', () => {
    beforeEach(() => {
      game.words = [
        { id: 1, word: 'canoeist', ownerId: ANA },
        { id: 2, word: 'oats', ownerId: BEN },
        { id: 3, word: 'rest', ownerId: BEN },
      ];
    });

    it('scores every word its owner is holding at the bell', () => {
      const result = service.finish(ROOM, clock)!;
      expect(result.scores).toEqual([
        { playerId: ANA, score: 5, words: 1, team: null },
        { playerId: BEN, score: 2, words: 2, team: null },
      ]);
      expect(result.winnerId).toBe(ANA);
      expect(result.tied).toBe(false);
    });

    it('calls a level board a draw', () => {
      game.words = [
        { id: 1, word: 'oats', ownerId: ANA },
        { id: 2, word: 'rest', ownerId: BEN },
      ];
      const result = service.finish(ROOM, clock)!;
      expect(result.tied).toBe(true);
      expect(result.winnerId).toBeNull();
    });

    it('is idempotent', () => {
      expect(service.finish(ROOM, clock)).not.toBeNull();
      expect(service.finish(ROOM, clock)).toBeNull();
    });

    it('refuses a claim once time is up', () => {
      setPool('zebra');
      expectCode(
        () => service.claim(ROOM, ANA, 'zebra', game.endsAt),
        'GAME_OVER',
      );
    });

    it('refuses a claim after the bell even mid-clock', () => {
      service.finish(ROOM, clock);
      setPool('zebra');
      expectCode(() => claim(ANA, 'zebra'), 'GAME_OVER');
    });

    it('reports the result on the shared state', () => {
      service.finish(ROOM, clock);
      const state = service.getState(ROOM, clock)!;
      expect(state.status).toBe('complete');
      expect(state.msRemaining).toBeNull();
      expect(state.result?.winnerId).toBe(ANA);
    });
  });

  describe('the shared view', () => {
    it('shows the same board to both players', () => {
      setPool('canoetsr');
      claim(ANA, 'canoe');
      const state = service.getState(ROOM, clock)!;
      expect(state.words).toEqual([
        { id: 1, word: 'canoe', ownerId: ANA, points: 2 },
      ]);
      expect(state.pool.sort()).toEqual(['r', 's', 't']);
      expect(state.scores).toEqual([
        { playerId: ANA, score: 2, words: 1, team: null },
        { playerId: BEN, score: 0, words: 0, team: null },
      ]);
    });

    it('returns nothing for a room with no game', () => {
      expect(service.getState('ZZZZ')).toBeNull();
    });
  });

  describe('restarting', () => {
    it('is refused mid-round', () => {
      expectCode(
        () => service.restart(ROOM, solo(ANA, BEN)),
        'GAME_IN_PROGRESS',
      );
    });

    it('clears the board and restarts the clock', () => {
      setPool('canoetsr');
      claim(ANA, 'canoe');
      service.finish(ROOM, clock);

      const next = service.restart(ROOM, solo(ANA, BEN), clock);
      expect(next.words).toEqual([]);
      expect(next.pool).toHaveLength(8);
      expect(next.status).toBe('playing');
      expect(next.endsAt).toBe(clock + 180_000);
    });
  });

  describe('squads (2v2)', () => {
    const ROOM2 = 'SQ2V';
    const CAL = 'cal';
    const DEB = 'deb';
    let squad: HeistGame;
    let squadClock: number;

    beforeEach(() => {
      squadClock = 2_000_000;
      service.ensureGame(
        ROOM2,
        [
          { id: ANA, team: 0 },
          { id: BEN, team: 0 },
          { id: CAL, team: 1 },
          { id: DEB, team: 1 },
        ],
        squadClock,
      );
      squad = service.getGame(ROOM2)!;
    });

    const squadClaim = (playerId: string, word: string, step = 1000) => {
      squadClock += step;
      return service.claim(ROOM2, playerId, word, squadClock);
    };

    const squadSetPool = (letters: string) => {
      squad.pool = [...letters];
    };

    it('scales the pool, drip and vowel floor for 4 players', () => {
      expect(squad.pool).toHaveLength(12);
      expect(squad.minPoolVowels).toBe(3);
      expect(squad.letterIntervalMs).toBe(3_000);
      expect(service.letterIntervalMs(ROOM2)).toBe(3_000);
    });

    it('never offers a teammate’s word as a steal candidate', () => {
      squad.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      squad.nextWordId = 2;
      squadSetPool('ist');
      // Ana and Ben are teammates, so `canoe` is never a candidate — not even
      // a blocked one. With the steal off the table and the pool alone unable
      // to spell `canoeist`, nothing legal is left.
      expectCode(() => squadClaim(ANA, 'canoeist'), 'LETTERS_UNAVAILABLE');
      expect(squad.words).toEqual([{ id: 1, word: 'canoe', ownerId: BEN }]);
    });

    it('still allows stealing from the opposing team', () => {
      squad.words = [{ id: 1, word: 'canoe', ownerId: CAL }];
      squad.nextWordId = 2;
      squadSetPool('ist');
      const outcome = squadClaim(ANA, 'canoeist');
      expect(outcome.type).toBe('steal');
      expect(outcome.stolenFrom).toBe(CAL);
    });

    it('still allows upgrading your own word', () => {
      squad.words = [{ id: 1, word: 'canoe', ownerId: ANA }];
      squadSetPool('ist');
      const outcome = squadClaim(ANA, 'canoeist');
      expect(outcome.stolenFrom).toBe(ANA);
    });

    it('sums each team’s score and names the winning team, not a player', () => {
      squad.words = [
        { id: 1, word: 'canoeist', ownerId: ANA }, // 5
        { id: 2, word: 'oats', ownerId: BEN }, // 1
        { id: 3, word: 'rest', ownerId: CAL }, // 1
        { id: 4, word: 'rested', ownerId: DEB }, // 3
      ];
      const result = service.finish(ROOM2, squadClock)!;
      expect(result.winnerId).toBeNull();
      expect(result.tied).toBe(false);
      expect(result.teamScores).toEqual([
        { team: 0, score: 6, playerIds: [ANA, BEN] },
        { team: 1, score: 4, playerIds: [CAL, DEB] },
      ]);
      expect(result.winningTeam).toBe(0);
    });

    it('calls a level team total a real tie even when individual scores differ', () => {
      squad.words = [
        { id: 1, word: 'canoeist', ownerId: ANA }, // 5, team 0
        { id: 2, word: 'stare', ownerId: CAL }, // 2
        { id: 3, word: 'stared', ownerId: DEB }, // 3, team 1 totals 5 too
      ];
      const result = service.finish(ROOM2, squadClock)!;
      expect(result.teamScores).toEqual([
        { team: 0, score: 5, playerIds: [ANA, BEN] },
        { team: 1, score: 5, playerIds: [CAL, DEB] },
      ]);
      expect(result.tied).toBe(true);
      expect(result.winningTeam).toBeNull();
      // Team decides in Squads — never an individual "winner" even though Ana
      // outscored everyone else on the board.
      expect(result.winnerId).toBeNull();
    });
  });

  it('keeps the minimum word length in step with scoring', () => {
    // A word at the minimum has to be worth something, or the floor is wrong.
    expect(wordPoints('a'.repeat(MIN_WORD_LENGTH))).toBe(1);
    expect(wordPoints('a'.repeat(MIN_WORD_LENGTH - 1))).toBe(0);
  });

  /**
   * `suggestClaims` is the bot AI's only window into the game: a bitmask
   * pre-filter over the whole dictionary, followed by the exact
   * `canSpell`/`remainder`/`isSuffixSteal` checks `claim` itself uses. These
   * tests care about one thing above all — that the pre-filter never lets a
   * candidate through that `claim` would actually reject.
   */
  describe('suggestClaims', () => {
    it('returns nothing for a room with no game', () => {
      expect(service.suggestClaims('NOPE', { playerId: ANA })).toEqual([]);
    });

    it('returns nothing once the round is over', () => {
      service.finish(ROOM, clock);
      expect(service.suggestClaims(ROOM, { playerId: ANA })).toEqual([]);
    });

    it('only suggests real dictionary words the live pool can actually spell', () => {
      setPool('canoetsr');
      const suggestions = service.suggestClaims(ROOM, { playerId: ANA });
      expect(suggestions.length).toBeGreaterThan(0);

      const poolCounts = letterCounts(game.pool.join(''));
      for (const s of suggestions) {
        expect(service.isWord(s.word)).toBe(true);
        if (s.type === 'pool') {
          expect(canSpell(letterCounts(s.word), poolCounts)).toBe(true);
        }
      }
    });

    it('respects letter multiplicity, not just which letters are present', () => {
      // The bitmask pre-filter can't tell 'coot' (needs two o's) from a pool
      // holding only one — the exact canSpell check right after it must.
      setPool('caot');
      const suggestions = service.suggestClaims(ROOM, { playerId: ANA });
      expect(suggestions.some((s) => s.word === 'coot')).toBe(false);
    });

    it('every suggested pool claim is actually accepted by claim()', () => {
      setPool('canoetsrle');
      const [top] = service.suggestClaims(ROOM, { playerId: ANA });
      expect(top).toBeDefined();
      expect(() => claim(ANA, top.word)).not.toThrow();
    });

    it('ranks candidates by points, highest first', () => {
      setPool('canoetsrle');
      const suggestions = service.suggestClaims(ROOM, { playerId: ANA });
      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i - 1].points).toBeGreaterThanOrEqual(
          suggestions[i].points,
        );
      }
    });

    it('suggests legal steals using the same rules claim() enforces, and they resolve', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      setPool('istx');

      const suggestions = service.suggestClaims(ROOM, { playerId: ANA });
      const steal = suggestions.find(
        (s) => s.type === 'steal' && s.word === 'canoeist',
      );
      expect(steal).toBeDefined();
      expect(steal!.target?.word).toBe('canoe');
      expect(() => claim(ANA, steal!.word)).not.toThrow();
    });

    it('never rejects a suggested steal the way claim() would (letters unavailable)', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      // 'z' isn't enough to steal 'canoe' into anything real; nothing should
      // be offered that claim() would then bounce.
      setPool('z');
      const suggestions = service.suggestClaims(ROOM, { playerId: ANA });
      expect(suggestions.every((s) => s.type !== 'steal')).toBe(true);
    });

    it('never offers a suffix-only steal, same as claim()', () => {
      game.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      setPool('s');
      const suggestions = service.suggestClaims(ROOM, { playerId: ANA });
      expect(suggestions.some((s) => s.word === 'canoes')).toBe(false);
    });

    it('never offers a teammate’s word as a steal target', () => {
      const squadRoom = 'SQ01';
      const squadGame = service.ensureGame(
        squadRoom,
        [
          { id: ANA, team: 0 },
          { id: BEN, team: 0 },
          { id: 'cal', team: 1 },
          { id: 'deb', team: 1 },
        ],
        clock,
      )!;
      squadGame.words = [{ id: 1, word: 'canoe', ownerId: BEN }];
      squadGame.pool = [...'istx'];

      const suggestions = service.suggestClaims(squadRoom, { playerId: ANA });
      expect(suggestions.some((s) => s.type === 'steal')).toBe(false);
    });
  });
});
