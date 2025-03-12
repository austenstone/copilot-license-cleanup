import * as core from '@actions/core';
import * as github from '@actions/github';
import momemt from 'moment';
import { writeFileSync } from 'fs';
import { DefaultArtifactClient } from '@actions/artifact'
import { SummaryTableRow } from '@actions/core/lib/summary';
import { Endpoints } from '@octokit/types';


type Seat = NonNullable<Endpoints['GET /orgs/{org}/copilot/billing/seats']['response']['data']['seats']>[0];
type SeatWithOrg = Seat & { organization: string };

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
  const result = {} as Input;
  result.token = core.getInput('github-token');
  result.org = core.getInput('organization');
  result.enterprise = core.getInput('enterprise');
  result.removeInactive = core.getBooleanInput('remove');
  result.removeFromTeam = core.getBooleanInput('remove-from-team');
  result.inactiveDays = parseInt(core.getInput('inactive-days'));
  result.jobSummary = core.getBooleanInput('job-summary');
  result.csv = core.getBooleanInput('csv');
  result.artifactName = core.getInput('artifact-name');
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  let organizations: string[] = [];
  let hasNextPage = false;
  let afterCursor: string | undefined = undefined;
  const allSeats: {
    [key: string]: {
      total_seats: Endpoints['GET /orgs/{org}/copilot/billing/seats']['response']['data']['total_seats']
      seats: Seat[];
      inactive: SeatWithOrg[];
    }
  } = {};
  let allRemovedSeatsCount = 0;

  const octokit = github.getOctokit(input.token);

  if (input.enterprise) {
    core.info(`Fetching all organizations for ${input.enterprise}...`);

    do {
      const query = `
        query ($enterprise: String!, $after: String) {
          enterprise(slug: $enterprise) {
            organizations(first: 100, after: $after) {
              pageInfo {
                endCursor
                hasNextPage
              }
              nodes {
                login
              }
            }
          }
        }
      `;

      const variables = { "enterprise": input.enterprise, "after": afterCursor };
      const response = await octokit.graphql<{
        enterprise: {
          organizations: {
            nodes: Array<{
              login: string;
            }>;
            pageInfo: {
              endCursor: string;
              hasNextPage: boolean;
            };
          };
        };
      }>(query, variables);

      organizations = organizations.concat(response.enterprise.organizations.nodes.map(org => org.login));

      hasNextPage = response.enterprise.organizations.pageInfo.hasNextPage;
      afterCursor = response.enterprise.organizations.pageInfo.endCursor;
    } while (hasNextPage);

    core.info(`Found ${organizations.length} organizations.`);
    core.debug(`Organization List: ${organizations.join(', ')}`);

  } else {
    organizations = input.org.split(',').map(org => org.trim());
  }

  for (const org of organizations) {
    const seatRsp = await octokit.paginate(octokit.rest.copilot.listCopilotSeats, { org });
    core.debug(`Response: ${JSON.stringify(seatRsp)}`);
    console.log(JSON.stringify(seatRsp, null, 2));
    if (!seatRsp.seats) {
      core.warning(`No seats found for organization ${org}`);
      continue;
    }
    
    const msToDays = (d: number): number => Math.ceil(d / (1000 * 3600 * 24));
    const now = new Date();
    
    const inactiveSeats = seatRsp.seats.filter(seat => {
      if (seat.last_activity_at === null || seat.last_activity_at === undefined) {
        const created = new Date(seat.created_at);
        const diff = now.getTime() - created.getTime();
        return msToDays(diff) > input.inactiveDays;
      }
      const lastActive = new Date(seat.last_activity_at);
      const diff = now.getTime() - lastActive.getTime();
      return msToDays(diff) > input.inactiveDays;
    }) || [];

    allSeats[org] = {
      total_seats: seatRsp.total_seats,
      seats: seatRsp.seats as Seat[],
      inactive: inactiveSeats.map(seat => ({ ...seat, organization: org })) as SeatWithOrg[]
    };

    if (input.removeInactive) {
      const seatsToRemove = inactiveSeats.filter(seat => !seat.assigning_team);
      if (seatsToRemove.length > 0) {
        await core.group('Removing inactive seats', async () => {
          const response = await octokit.rest.copilot.cancelCopilotSeatAssignmentForUsers({
            org: org,
            selected_usernames: seatsToRemove.map(seat => seat.assignee.login as string),
          })
          allRemovedSeatsCount += response.data.seats_cancelled;
        });
      }
    }

    if (input.removeFromTeam) {
      const inactiveSeatsAssignedByTeam = inactiveSeats.filter(seat => seat.assigning_team);
      await core.group('Removing inactive seats from team', async () => {
        for (const seat of inactiveSeatsAssignedByTeam) {
          if (!seat.assigning_team || typeof (seat.assignee.login) !== 'string') continue;

          const response = await octokit.rest.teams.getMembershipForUserInOrg({
            org: org,
            team_slug: seat.assigning_team.slug,
            username: seat.assignee.login
          })
          core.debug(`User ${seat.assignee.login} has ${response.data.role} role on team ${seat.assigning_team.slug}`)

          if (response.data.role === 'maintainer') {
            core.info(`Inactive user ${seat.assignee.login} is maintainer, skipping removal`)
            continue
          }

          await octokit.rest.teams.removeMembershipForUserInOrg({
            org: org,
            team_slug: seat.assigning_team.slug,
            username: seat.assignee.login
          })
          core.info(`${seat.assignee.login} removed from team ${seat.assigning_team.slug}`)
        }
      });
    }

    if (input.jobSummary) {
      await core.summary
        .addHeading(`${org} - Inactive Seats: ${inactiveSeats.length} / ${seatRsp.total_seats}`)
      if (seatRsp.seats?.length || 0 > 0) {
        core.summary.addTable([
          [
            { data: 'Avatar', header: true },
            { data: 'Login', header: true },
            { data: 'Last Activity', header: true },
            { data: 'Last Editor Used', header: true }
          ],
          ...inactiveSeats.sort((a, b) => {
            const loginA = (a.assignee.login || 'Unknown') as string;
            const loginB = (b.assignee.login || 'Unknown') as string;
            return loginA.localeCompare(loginB);
          }).map(seat => [
            `<img src="${seat.assignee.avatar_url}" width="33" />`,
            seat.assignee.login || 'Unknown',
            seat.last_activity_at === null ? 'No activity' : momemt(seat.last_activity_at).fromNow(),
            seat.last_activity_editor || 'Unknown'
          ] as SummaryTableRow)
        ])
      }
      core.summary.addLink('Manage GitHub Copilot seats', `https://github.com/organizations/${org}/settings/copilot/seat_management`)
        .write()
    }
  }

  if (input.csv) {
    core.group('Writing CSV', async () => {
      const seats = Object.values(allSeats).flatMap(seat => seat.inactive);
      const sortedSeats = seats.sort((a, b) => {
        if (a.organization < b.organization) return -1;
        if (a.organization > b.organization) return 1;
        if (a.assignee.login && b.assignee.login) {
          if (a.assignee.login < b.assignee.login) return -1;
          if (a.assignee.login > b.assignee.login) return 1;
        }
        return 0;
      });

      const fileName = 'inactive-seats.csv';
      const csv = [
        ['Organization', 'Login', 'Last Activity', 'Last Editor Used'],
        ...sortedSeats.map(seat => [
          seat?.organization,
          seat?.assignee.login,
          seat?.last_activity_at === null ? 'No activity' : momemt(seat?.last_activity_at).fromNow(),
          seat?.last_activity_editor || '-'
        ])
      ].map(row => row.join(',')).join('\n');
      writeFileSync(fileName, csv);
      const artifact = new DefaultArtifactClient();
      await artifact.uploadArtifact(input.artifactName, [fileName], '.');
    });
  }

  core.setOutput('inactive-seats', JSON.stringify(allSeats));
  const totalInactiveSeats = Object.values(allSeats).reduce((sum, org) => sum + org.inactive.length, 0);
  core.setOutput('inactive-seat-count', totalInactiveSeats.toString());
  core.setOutput('removed-seats', allRemovedSeatsCount.toString());
  core.setOutput('seat-count', Object.values(allSeats).reduce((sum, org) => sum + (org.total_seats || 0), 0).toString());
};

run();
