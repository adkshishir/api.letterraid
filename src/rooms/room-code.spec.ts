import {
  ROOM_CODE_CHARSET,
  ROOM_CODE_LENGTH,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from './room-code';

describe('room-code', () => {
  describe('generateRoomCode', () => {
    it('produces a code of the expected length from the charset', () => {
      const code = generateRoomCode(() => false);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect([...code].every((c) => ROOM_CODE_CHARSET.includes(c))).toBe(true);
    });

    it('never emits visually ambiguous characters', () => {
      const codes = Array.from({ length: 200 }, () =>
        generateRoomCode(() => false),
      );
      expect(codes.join('')).not.toMatch(/[01OI]/);
    });

    it('retries until it finds a code that is not taken', () => {
      const taken = new Set<string>();
      let calls = 0;
      const isTaken = (code: string) => {
        calls += 1;
        // Reject the first two candidates outright to force retries.
        if (calls <= 2) return true;
        return taken.has(code);
      };
      const code = generateRoomCode(isTaken);
      expect(calls).toBeGreaterThan(2);
      expect(isValidRoomCode(code)).toBe(true);
    });
  });

  describe('normalizeRoomCode', () => {
    it('uppercases and trims pasted input', () => {
      expect(normalizeRoomCode('  ab2c \n')).toBe('AB2C');
    });
  });

  describe('isValidRoomCode', () => {
    it('accepts a well-formed code regardless of case or padding', () => {
      expect(isValidRoomCode(' ab2c ')).toBe(true);
    });

    it('rejects wrong lengths', () => {
      expect(isValidRoomCode('AB2')).toBe(false);
      expect(isValidRoomCode('AB2CD')).toBe(false);
    });

    it('rejects characters excluded from the charset', () => {
      // These are exactly the ambiguous characters a user might type by mistake.
      expect(isValidRoomCode('AB0C')).toBe(false);
      expect(isValidRoomCode('AB1C')).toBe(false);
      expect(isValidRoomCode('ABOC')).toBe(false);
      expect(isValidRoomCode('ABIC')).toBe(false);
    });
  });
});
