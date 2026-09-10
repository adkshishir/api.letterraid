import { ApiProperty } from '@nestjs/swagger';

/** Clash-Royale-style presets — a fixed menu, not a free-typed number. */
export const TOURNAMENT_SIZES = [10, 50, 100] as const;
export type TournamentSize = (typeof TOURNAMENT_SIZES)[number];

export const TOURNAMENT_DURATIONS_MIN = [30, 60, 120] as const;
export type TournamentDurationMin = (typeof TOURNAMENT_DURATIONS_MIN)[number];

export const TOURNAMENT_NAME_MAX_LENGTH = 40;

export type TournamentStatus = 'LOBBY' | 'OPEN' | 'COMPLETE';

export class TournamentStanding {
  @ApiProperty() playerId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() wins!: number;
  @ApiProperty() losses!: number;
  @ApiProperty({ description: 'League-style score: +3 win, +1 tie, +0 loss.' })
  points!: number;
}

export class TournamentSummary {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Short shareable join code.' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: TOURNAMENT_SIZES }) maxMembers!: number;
  @ApiProperty({ enum: TOURNAMENT_DURATIONS_MIN }) durationMin!: number;
  @ApiProperty() memberCount!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null while the tournament is still a lobby (not yet started).',
  })
  startedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null while the tournament is still a lobby (not yet started).',
  })
  endsAt!: string | null;
  @ApiProperty({ enum: ['LOBBY', 'OPEN', 'COMPLETE'] }) status!: TournamentStatus;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null for a public tournament; set for a clan-private one.',
  })
  clanId!: string | null;
}

export class TournamentDetail extends TournamentSummary {
  @ApiProperty() createdAt!: string;
  @ApiProperty() creatorId!: string;
  @ApiProperty({ nullable: true, type: String }) clanName!: string | null;
  @ApiProperty() isParticipant!: boolean;
  @ApiProperty({ type: [TournamentStanding] }) standings!: TournamentStanding[];
}

/**
 * LOBBY until the host starts it (`startedAt`/`endsAt` both null) — players
 * can join but not queue for matches. Then OPEN until `endsAt`, then
 * COMPLETE. There's no stored status column; it's always derived so there's
 * no background sweep job for either transition.
 */
export function deriveStatus(
  startedAt: Date | null,
  endsAt: Date | null,
  now = new Date(),
): TournamentStatus {
  if (!startedAt || !endsAt) return 'LOBBY';
  return now >= endsAt ? 'COMPLETE' : 'OPEN';
}
