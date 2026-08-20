import { Endpoints } from '@octokit/types';

export type Seat = NonNullable<
  Endpoints['GET /orgs/{org}/copilot/billing/seats']['response']['data']['seats']
>[0];
/** The API's own `organization` object is replaced with the org login the seat was found under. */
export type SeatWithOrg = Omit<Seat, 'organization'> & { organization: string };
export type AssigningTeam = NonNullable<Seat['assigning_team']>;
export type OrgTeam = Extract<AssigningTeam, { permission: string }>;

const MS_PER_DAY = 1000 * 3600 * 24;

/**
 * The seats endpoint has no documented cap on `selected_usernames`, but a single
 * request carrying every inactive user in a large enterprise is a reliability risk.
 */
export const REMOVAL_BATCH_SIZE = 50;

export const daysSince = (timestamp: string | null | undefined, now: Date): number | null => {
  if (!timestamp) return null;
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return null;
  return Math.ceil((now.getTime() - then) / MS_PER_DAY);
};

/**
 * A seat with no recorded activity is judged on how long it has been assigned, so a
 * freshly granted seat is never treated as inactive before it has had a chance to be used.
 */
export const isSeatInactive = (seat: Seat, inactiveDays: number, now: Date): boolean => {
  const idleDays = daysSince(seat.last_activity_at, now) ?? daysSince(seat.created_at, now);
  return idleDays !== null && idleDays > inactiveDays;
};

/**
 * Enterprise teams share the org team URL shape but are not addressable through the org
 * teams API, and an unrelated org team can share their slug. Mis-identifying one would
 * remove a user from the wrong team, so anything not provably an org team is left alone.
 */
export const isOrgTeam = (team: AssigningTeam): team is OrgTeam =>
  'permission' in team && !/\/enterprises\//.test(team.html_url ?? '');

export const getSeatLogin = (seat: Pick<Seat, 'assignee'>): string | undefined => {
  const login = seat.assignee?.login;
  return typeof login === 'string' && login.length > 0 ? login : undefined;
};

/**
 * Seats granted through a team cannot be cancelled directly (the API rejects them with a
 * 422), and seats already pending cancellation would be cancelled a second time.
 */
export const selectDirectlyAssignedSeats = (seats: Seat[]): Seat[] =>
  seats.filter(
    (seat) => !seat.assigning_team && !seat.pending_cancellation_date && getSeatLogin(seat)
  );

export const selectTeamAssignedSeats = (seats: Seat[]): Seat[] =>
  seats.filter((seat) => seat.assigning_team && getSeatLogin(seat));

export const batch = <T>(items: T[], size: number): T[][] => {
  if (size < 1) throw new Error(`batch size must be at least 1, got ${size}`);
  return items.reduce<T[][]>((acc, item, i) => {
    if (i % size === 0) acc.push([]);
    acc[acc.length - 1].push(item);
    return acc;
  }, []);
};

export const parseOrganizations = (input: string): string[] =>
  input
    .split(',')
    .map((org) => org.trim())
    .filter((org) => org.length > 0);

export const parseInactiveDays = (raw: string): number => {
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`inactive-days must be a positive whole number, got "${raw}"`);
  }
  return days;
};

/**
 * GitHub silently discards an entire job summary larger than 1MiB, so an
 * unbounded seat table costs you the whole report rather than the overflow.
 * A rendered row measures ~187 bytes, and core.summary.write() appends, so the
 * budget is shared across every organization in a run.
 */
export const SUMMARY_MAX_TABLE_ROWS = 2000;

export const takeRows = <T>(
  rows: T[],
  remaining: number
): { shown: T[]; omitted: number; remaining: number } => {
  const shown = remaining > 0 ? rows.slice(0, remaining) : [];
  return {
    shown,
    omitted: rows.length - shown.length,
    remaining: Math.max(0, remaining - shown.length),
  };
};
