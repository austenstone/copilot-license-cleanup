import * as core from '@actions/core';
import * as github from '@actions/github';
import moment from 'moment';
import { writeFileSync } from 'fs';
import { DefaultArtifactClient } from '@actions/artifact';
import {
  Seat,
  SeatWithOrg,
  REMOVAL_BATCH_SIZE,
  batch,
  getSeatLogin,
  isOrgTeam,
  isSeatInactive,
  parseInactiveDays,
  parseOrganizations,
  selectDirectlyAssignedSeats,
  selectTeamAssignedSeats,
} from './seats';

type SummaryTableRow = Parameters<typeof core.summary.addTable>[0][number];
type Octokit = ReturnType<typeof github.getOctokit>;

interface Input {
  token: string;
  org: string;
  enterprise: string;
  removeInactive: boolean;
  removeFromTeam: boolean;
  inactiveDays: number;
  jobSummary: boolean;
  csv: boolean;
  artifactName: string;
}

export function getInputs(): Input {
  return {
    token: core.getInput('github-token'),
    org: core.getInput('organization'),
    enterprise: core.getInput('enterprise'),
    removeInactive: core.getBooleanInput('remove'),
    removeFromTeam: core.getBooleanInput('remove-from-team'),
    inactiveDays: parseInactiveDays(core.getInput('inactive-days')),
    jobSummary: core.getBooleanInput('job-summary'),
    csv: core.getBooleanInput('csv'),
    artifactName: core.getInput('artifact-name'),
  };
}

const getEnterpriseOrganizations = async (
  octokit: Octokit,
  enterprise: string
): Promise<string[]> => {
  const query = `
    query ($enterprise: String!, $after: String) {
      enterprise(slug: $enterprise) {
        organizations(first: 100, after: $after) {
          pageInfo { endCursor hasNextPage }
          nodes { login }
        }
      }
    }
  `;

  const organizations: string[] = [];
  let afterCursor: string | undefined = undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await octokit.graphql<{
      enterprise: {
        organizations: {
          nodes: Array<{ login: string }>;
          pageInfo: { endCursor: string; hasNextPage: boolean };
        };
      };
    }>(query, { enterprise, after: afterCursor });

    organizations.push(...response.enterprise.organizations.nodes.map((org) => org.login));
    hasNextPage = response.enterprise.organizations.pageInfo.hasNextPage;
    afterCursor = response.enterprise.organizations.pageInfo.endCursor;
  }

  return organizations;
};

const fetchSeats = async (
  octokit: Octokit,
  org: string
): Promise<{ totalSeats: number; seats: Seat[] }> => {
  const pages = (await octokit.paginate(octokit.rest.copilot.listCopilotSeats, {
    org,
    per_page: 100,
  })) as unknown as { total_seats?: number; seats?: Seat[] }[];

  return {
    totalSeats: pages[0]?.total_seats ?? 0,
    seats: pages.flatMap((page) => page.seats ?? []),
  };
};

const removeSeats = async (octokit: Octokit, org: string, seats: Seat[]): Promise<number> => {
  const logins = seats.map(getSeatLogin).filter((login): login is string => Boolean(login));
  if (logins.length === 0) return 0;

  let removed = 0;
  for (const chunk of batch(logins, REMOVAL_BATCH_SIZE)) {
    const response = await octokit.rest.copilot.cancelCopilotSeatAssignmentForUsers({
      org,
      selected_usernames: chunk,
    });
    removed += response.data.seats_cancelled;
    core.info(`Cancelled ${response.data.seats_cancelled} seat(s) in ${org}: ${chunk.join(', ')}`);
  }
  return removed;
};

const removeSeatsFromTeams = async (octokit: Octokit, org: string, seats: Seat[]): Promise<void> => {
  for (const seat of seats) {
    const login = getSeatLogin(seat);
    const team = seat.assigning_team;
    if (!login || !team) continue;

    if (!isOrgTeam(team)) {
      core.warning(
        `Skipping ${login}: seat is assigned via enterprise team "${team.slug}", which cannot be managed through the organization teams API.`
      );
      continue;
    }

    const membership = await octokit.rest.teams.getMembershipForUserInOrg({
      org,
      team_slug: team.slug,
      username: login,
    });

    if (membership.data.role === 'maintainer') {
      core.info(`Inactive user ${login} is a maintainer of ${team.slug}, skipping removal`);
      continue;
    }

    await octokit.rest.teams.removeMembershipForUserInOrg({
      org,
      team_slug: team.slug,
      username: login,
    });
    core.info(`${login} removed from team ${team.slug}`);
  }
};

const writeJobSummary = async (
  org: string,
  totalSeats: number,
  inactiveSeats: Seat[]
): Promise<void> => {
  core.summary.addHeading(`${org} - Inactive Seats: ${inactiveSeats.length} / ${totalSeats}`);

  if (inactiveSeats.length > 0) {
    core.summary.addTable([
      [
        { data: 'Avatar', header: true },
        { data: 'Login', header: true },
        { data: 'Last Activity', header: true },
        { data: 'Last Editor Used', header: true },
      ],
      ...[...inactiveSeats]
        .sort(
          (a, b) =>
            new Date(a.last_activity_at || 0).getTime() -
            new Date(b.last_activity_at || 0).getTime()
        )
        .map(
          (seat) =>
            [
              `<img src="${seat.assignee?.avatar_url ?? ''}" width="33" />`,
              getSeatLogin(seat) ?? 'Unknown',
              seat.last_activity_at ? moment(seat.last_activity_at).fromNow() : 'No activity',
              seat.last_activity_editor || 'Unknown',
            ] as SummaryTableRow
        ),
    ]);
  }

  await core.summary
    .addLink(
      'Manage GitHub Copilot seats',
      `https://github.com/organizations/${org}/settings/copilot/seat_management`
    )
    .write();
};

const uploadCsv = async (seats: SeatWithOrg[], artifactName: string): Promise<void> => {
  const sorted = [...seats].sort(
    (a, b) =>
      a.organization.localeCompare(b.organization) ||
      (getSeatLogin(a) ?? '').localeCompare(getSeatLogin(b) ?? '')
  );

  const fileName = 'inactive-seats.csv';
  const csv = [
    ['Organization', 'Login', 'Last Activity', 'Last Editor Used'],
    ...sorted.map((seat) => [
      seat.organization,
      getSeatLogin(seat) ?? '',
      seat.last_activity_at ? moment(seat.last_activity_at).fromNow() : 'No activity',
      seat.last_activity_editor || '-',
    ]),
  ]
    .map((row) => row.join(','))
    .join('\n');

  writeFileSync(fileName, csv);
  await new DefaultArtifactClient().uploadArtifact(artifactName, [fileName], '.');
};

const run = async (): Promise<void> => {
  const input = getInputs();
  const octokit = github.getOctokit(input.token);

  const organizations = input.enterprise
    ? await core.group(`Fetching organizations for ${input.enterprise}`, () =>
        getEnterpriseOrganizations(octokit, input.enterprise)
      )
    : parseOrganizations(input.org);

  if (organizations.length === 0) {
    throw new Error('No organizations to process. Set the "organization" or "enterprise" input.');
  }
  core.info(`Processing ${organizations.length} organization(s).`);

  if (!input.removeInactive && !input.removeFromTeam) {
    core.info('Running in report-only mode. No seats will be removed.');
  }

  const allSeats: Record<string, { total_seats: number; seats: Seat[]; inactive: SeatWithOrg[] }> =
    {};
  const failedOrgs: string[] = [];
  let allRemovedSeatsCount = 0;
  const now = new Date();

  for (const org of organizations) {
    try {
      core.info(`Fetching Copilot seat assignments for organization ${org}`);
      const { totalSeats, seats } = await fetchSeats(octokit, org);

      if (seats.length === 0) {
        core.warning(`No seats found for organization ${org}`);
        continue;
      }

      const inactiveSeats = seats.filter((seat) => isSeatInactive(seat, input.inactiveDays, now));
      allSeats[org] = {
        total_seats: totalSeats,
        seats,
        inactive: inactiveSeats.map((seat) => ({ ...seat, organization: org })),
      };
      core.info(`${org}: ${inactiveSeats.length} inactive of ${totalSeats} seat(s)`);

      const directlyAssigned = selectDirectlyAssignedSeats(inactiveSeats);
      const teamAssigned = selectTeamAssignedSeats(inactiveSeats);

      if (directlyAssigned.length > 0) {
        if (input.removeInactive) {
          allRemovedSeatsCount += await core.group('Removing inactive seats', () =>
            removeSeats(octokit, org, directlyAssigned)
          );
        } else {
          core.info(
            `Would remove ${directlyAssigned.length} directly assigned seat(s) from ${org}. Set "remove: true" to apply.`
          );
        }
      }

      if (teamAssigned.length > 0) {
        if (input.removeFromTeam) {
          await core.group('Removing inactive seats from team', () =>
            removeSeatsFromTeams(octokit, org, teamAssigned)
          );
        } else {
          core.info(
            `Would remove ${teamAssigned.length} user(s) from their assigning team in ${org}. Set "remove-from-team: true" to apply.`
          );
        }
      }

      if (input.jobSummary) {
        await writeJobSummary(org, totalSeats, inactiveSeats);
      }
    } catch (error) {
      failedOrgs.push(org);
      core.error(`Failed to process organization ${org}: ${(error as Error).message}`);
    }
  }

  const inactive = Object.values(allSeats).flatMap((org) => org.inactive);

  if (input.csv) {
    await core.group('Writing CSV', () => uploadCsv(inactive, input.artifactName));
  }

  core.setOutput('inactive-seats', JSON.stringify(allSeats));
  core.setOutput('inactive-seat-count', inactive.length.toString());
  core.setOutput('removed-seats', allRemovedSeatsCount.toString());
  core.setOutput(
    'seat-count',
    Object.values(allSeats)
      .reduce((sum, org) => sum + (org.total_seats || 0), 0)
      .toString()
  );

  if (failedOrgs.length > 0) {
    throw new Error(`Failed to process organization(s): ${failedOrgs.join(', ')}`);
  }
};

run().catch((error) => core.setFailed((error as Error).message));
