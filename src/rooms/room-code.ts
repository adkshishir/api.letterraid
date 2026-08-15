/**
 * Room code generation, ported from imposter's proven `generateCode()`.
 *
 * Charset deliberately omits `0`/`O` and `1`/`I` — room codes get read aloud
 * and typed on phones, and those pairs are the ones people get wrong.
 */
export const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

/**
 * Generates a room code not already in use.
 *
 * @param isTaken predicate for collision checking against live rooms
 */
export function generateRoomCode(isTaken: (code: string) => boolean): string {
  // 32^4 ≈ 1.05M codes. Collisions only matter against *concurrently live*
  // rooms, not all rooms ever, so retrying on collision is cheap indefinitely.
  let code: string;
  do {
    code = Array.from(
      { length: ROOM_CODE_LENGTH },
      () =>
        ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)],
    ).join('');
  } while (isTaken(code));
  return code;
}

/** Normalizes user-entered codes (lowercase paste, stray whitespace). */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input);
  if (code.length !== ROOM_CODE_LENGTH) return false;
  return [...code].every((char) => ROOM_CODE_CHARSET.includes(char));
}
