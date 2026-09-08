import { ApiProperty } from '@nestjs/swagger';

export const CLAN_NAME_MIN_LENGTH = 3;
export const CLAN_NAME_MAX_LENGTH = 24;

/** A clan's roster is capped the same way a room isn't — this is a social group, not a match. */
export const MAX_CLAN_MEMBERS = 50;

export class ClanRosterEntry {
  @ApiProperty() playerId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty() trophies!: number;
  @ApiProperty({ enum: ['LEADER', 'MEMBER'] }) role!: 'LEADER' | 'MEMBER';
  @ApiProperty() joinedAt!: string;
}

export class ClanDetail {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() memberCount!: number;
  @ApiProperty() totalTrophies!: number;
  @ApiProperty({
    enum: ['LEADER', 'MEMBER'],
    nullable: true,
    description: 'The requester’s role in this clan, or null if unauthenticated or not a member.',
  })
  myRole!: 'LEADER' | 'MEMBER' | null;
  @ApiProperty({ type: [ClanRosterEntry] }) roster!: ClanRosterEntry[];
}

export class ClanSummary {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() memberCount!: number;
  @ApiProperty() totalTrophies!: number;
}
