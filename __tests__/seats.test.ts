import {
  batch,
  daysSince,
  getSeatLogin,
  isOrgTeam,
  isSeatInactive,
  parseInactiveDays,
  parseOrganizations,
  selectDirectlyAssignedSeats,
  selectTeamAssignedSeats,
  AssigningTeam,
  Seat,
  SUMMARY_MAX_TABLE_ROWS,
  takeRows,
} from '../src/seats';

const NOW = new Date('2026-08-20T00:00:00Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 3600 * 1000).toISOString();

const seat = (overrides: Partial<Seat> = {}): Seat =>
  ({
    assignee: { login: 'octocat' },
    created_at: daysAgo(365),
    ...overrides,
  }) as Seat;

const orgTeam = (overrides: Record<string, unknown> = {}) =>
  ({
    slug: 'engineering',
    permission: 'pull',
    html_url: 'https://github.com/orgs/acme/teams/engineering',
    ...overrides,
  }) as unknown as AssigningTeam;

const enterpriseTeam = (overrides: Record<string, unknown> = {}) =>
  ({
    slug: 'engineering',
    group_id: '42',
    html_url: 'https://github.com/enterprises/acme/teams/engineering',
    ...overrides,
  }) as unknown as AssigningTeam;

describe('daysSince', () => {
  it('returns null for missing or unparseable timestamps', () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince('', NOW)).toBeNull();
    expect(daysSince('not-a-date', NOW)).toBeNull();
  });

  it('measures elapsed days', () => {
    expect(daysSince(daysAgo(30), NOW)).toBe(30);
    expect(daysSince(NOW.toISOString(), NOW)).toBe(0);
  });
});

describe('isSeatInactive', () => {
  it('flags seats idle longer than the threshold', () => {
    expect(isSeatInactive(seat({ last_activity_at: daysAgo(91) }), 90, NOW)).toBe(true);
  });

  it('keeps seats used within the threshold', () => {
    expect(isSeatInactive(seat({ last_activity_at: daysAgo(89) }), 90, NOW)).toBe(false);
  });

  it('treats the threshold itself as still active', () => {
    expect(isSeatInactive(seat({ last_activity_at: daysAgo(90) }), 90, NOW)).toBe(false);
  });

  it('falls back to creation date when a seat has never been used', () => {
    expect(isSeatInactive(seat({ last_activity_at: null, created_at: daysAgo(91) }), 90, NOW)).toBe(
      true
    );
  });

  it('spares a newly granted seat that has not been used yet', () => {
    expect(isSeatInactive(seat({ last_activity_at: null, created_at: daysAgo(3) }), 90, NOW)).toBe(
      false
    );
  });
});

describe('isOrgTeam', () => {
  it('accepts organization teams', () => {
    expect(isOrgTeam(orgTeam())).toBe(true);
  });

  it('rejects enterprise teams, which the org teams API cannot manage', () => {
    expect(isOrgTeam(enterpriseTeam())).toBe(false);
  });

  it('rejects an enterprise team even when it shares an org team slug', () => {
    expect(isOrgTeam(enterpriseTeam({ slug: 'engineering', permission: 'pull' }))).toBe(false);
  });
});

describe('getSeatLogin', () => {
  it('returns the login when present', () => {
    expect(getSeatLogin(seat())).toBe('octocat');
  });

  it('returns undefined instead of throwing on a null assignee', () => {
    expect(getSeatLogin({ assignee: null } as Seat)).toBeUndefined();
    expect(getSeatLogin({} as Seat)).toBeUndefined();
    expect(getSeatLogin({ assignee: { login: '' } } as Seat)).toBeUndefined();
  });

  it('produces a flat login array a job matrix can consume', () => {
    const seats = [
      seat(),
      { assignee: null } as Seat,
      seat({ assignee: { login: 'hubot' } as Seat['assignee'] }),
    ];
    expect(seats.map(getSeatLogin).filter(Boolean)).toEqual(['octocat', 'hubot']);
  });
});

describe('selectDirectlyAssignedSeats', () => {
  it('selects only seats that can actually be cancelled', () => {
    const direct = seat();
    const selected = selectDirectlyAssignedSeats([
      direct,
      seat({ assigning_team: orgTeam() }),
      seat({ pending_cancellation_date: '2026-09-01' }),
      { assignee: null } as Seat,
    ]);
    expect(selected).toEqual([direct]);
  });
});

describe('selectTeamAssignedSeats', () => {
  it('selects team-assigned seats that have a login', () => {
    const viaTeam = seat({ assigning_team: orgTeam() });
    expect(selectTeamAssignedSeats([viaTeam, seat()])).toEqual([viaTeam]);
  });
});

describe('batch', () => {
  it('splits into chunks without dropping or duplicating items', () => {
    expect(batch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batch([1, 2], 5)).toEqual([[1, 2]]);
    expect(batch([], 5)).toEqual([]);
  });

  it('rejects a batch size that would loop forever', () => {
    expect(() => batch([1], 0)).toThrow();
  });
});

describe('parseOrganizations', () => {
  it('parses and trims comma separated organizations', () => {
    expect(parseOrganizations(' acme , globex ')).toEqual(['acme', 'globex']);
    expect(parseOrganizations('acme,,')).toEqual(['acme']);
    expect(parseOrganizations('')).toEqual([]);
  });
});

describe('parseInactiveDays', () => {
  it('accepts positive whole numbers', () => {
    expect(parseInactiveDays('90')).toBe(90);
  });

  it('rejects values that would silently match nothing', () => {
    for (const raw of ['', 'abc', '0', '-1', '1.5']) {
      expect(() => parseInactiveDays(raw)).toThrow();
    }
  });
});

describe('takeRows', () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);

  it('returns everything when the budget is larger than the row count', () => {
    expect(takeRows(rows, 100)).toEqual({ shown: rows, omitted: 0, remaining: 90 });
  });

  it('caps the rows and reports how many were omitted', () => {
    const { shown, omitted, remaining } = takeRows(rows, 4);
    expect(shown).toEqual([0, 1, 2, 3]);
    expect(omitted).toBe(6);
    expect(remaining).toBe(0);
  });

  it('shows nothing once the budget is spent', () => {
    expect(takeRows(rows, 0)).toEqual({ shown: [], omitted: 10, remaining: 0 });
  });

  it('never reports a negative budget', () => {
    expect(takeRows(rows, -5).remaining).toBe(0);
  });

  it('shares the budget across successive organizations', () => {
    const first = takeRows(rows, 12);
    const second = takeRows(rows, first.remaining);
    expect(second.shown).toHaveLength(2);
    expect(second.omitted).toBe(8);
    expect(second.remaining).toBe(0);
  });

  it('keeps a full run of large organizations under the 1MiB summary limit', () => {
    const bytesPerRow = 187;
    expect(SUMMARY_MAX_TABLE_ROWS * bytesPerRow).toBeLessThan(1024 * 1024);
  });
});
