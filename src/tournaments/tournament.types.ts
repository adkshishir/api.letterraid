/** Clash-Royale-style presets — a fixed menu, not a free-typed number. */
export const TOURNAMENT_SIZES = [10, 50, 100] as const;
export type TournamentSize = (typeof TOURNAMENT_SIZES)[number];

export const TOURNAMENT_DURATIONS_MIN = [30, 60, 120] as const;
export type TournamentDurationMin = (typeof TOURNAMENT_DURATIONS_MIN)[number];

export const TOURNAMENT_NAME_MAX_LENGTH = 40;

export type TournamentStatus = 'OPEN' | 'COMPLETE';

export interface TournamentStanding {
  playerId: string;
  displayName: string;
  wins: number;
  losses: number;
  points: number;
}

export interface TournamentSummary {
  id: string;
  code: string;
  name: string;
  maxMembers: number;
  durationMin: number;
  memberCount: number;
  endsAt: string;
  status: TournamentStatus;
  clanId: string | null;
}

export interface TournamentDetail extends TournamentSummary {
  createdAt: string;
  creatorId: string;
  clanName: string | null;
  isParticipant: boolean;
  standings: TournamentStanding[];
}

export function deriveStatus(endsAt: Date, now = new Date()): TournamentStatus {
  return now >= endsAt ? 'COMPLETE' : 'OPEN';
}
