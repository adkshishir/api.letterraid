export const CLAN_NAME_MIN_LENGTH = 3;
export const CLAN_NAME_MAX_LENGTH = 24;

/** A clan's roster is capped the same way a room isn't — this is a social group, not a match. */
export const MAX_CLAN_MEMBERS = 50;

export interface ClanRosterEntry {
  playerId: string;
  displayName: string;
  avatarUrl: string | null;
  trophies: number;
  role: 'LEADER' | 'MEMBER';
  joinedAt: string;
}

export interface ClanDetail {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  totalTrophies: number;
  /** Present only when the request is authenticated. */
  myRole: 'LEADER' | 'MEMBER' | null;
  roster: ClanRosterEntry[];
}

export interface ClanSummary {
  id: string;
  name: string;
  memberCount: number;
  totalTrophies: number;
}
