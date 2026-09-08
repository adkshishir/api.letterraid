import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  TOURNAMENT_DURATIONS_MIN,
  TOURNAMENT_NAME_MAX_LENGTH,
  TOURNAMENT_SIZES,
} from './tournament.types.js';
import type { TournamentDurationMin, TournamentSize } from './tournament.types.js';

export class CreateTournamentDto {
  @ApiProperty({ maxLength: TOURNAMENT_NAME_MAX_LENGTH, example: 'Friday Night Raid' })
  @IsString()
  @MinLength(1)
  @MaxLength(TOURNAMENT_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    enum: TOURNAMENT_SIZES,
    description: 'Maximum participants. Fixed menu, not a free-typed number.',
  })
  @IsIn(TOURNAMENT_SIZES)
  maxMembers!: TournamentSize;

  @ApiProperty({
    enum: TOURNAMENT_DURATIONS_MIN,
    description: 'How long the tournament stays open, in minutes.',
  })
  @IsIn(TOURNAMENT_DURATIONS_MIN)
  durationMin!: TournamentDurationMin;

  @ApiPropertyOptional({
    description:
      'Host this tournament for one clan only — the caller must already be ' +
      'a member. Omit for a public tournament anyone can browse into.',
  })
  @IsOptional()
  @IsString()
  clanId?: string;
}
