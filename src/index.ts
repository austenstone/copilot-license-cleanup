/* eslint-disable no-mixed-spaces-and-tabs */
import * as core from '@actions/core';
import * as github from '@actions/github';
import momemt from 'moment';
import { writeFileSync } from 'fs';
import * as artifact from '@actions/artifact';
import type { Endpoints } from "@octokit/types";
import { SummaryTableRow } from '@actions/core/lib/summary';
import { RequestError } from '@octokit/request-error';
import { deployment } from './deployment';


export interface Input {
  token: string;
  org: string;
  enterprise: string;
  removeInactive: boolean;
  removefromTeam: boolean;
  inactiveDays: number;
  jobSummary: boolean;
  csv: boolean;
  deployUsers: boolean;
  deployUsersDryRun: boolean;
  deployUsersCsv: string;
  deployValidationTime: number;
}

type SeatWithOrg = { 
  last_activity_at: string | null; 
  created_at: string; 
  organization: string; 
  assignee: { login: string; avatar_url: string; }; 
  last_activity_editor: string | null; 
};

function getInactiveSeats(org: string, seats, inactiveDays: number) {
  const msToDays = (d) => Math.ceil(d / (1000 * 3600 * 24));

  const now = new Date();
  const inactiveSeats = seats.filter(seat => {
    if (seat.last_activity_at === null || seat.last_activity_at === undefined) {
      const created = new Date(seat.created_at);
      const diff = now.getTime() - created.getTime();
      return msToDays(diff) > inactiveDays;
    }
    const lastActive = new Date(seat.last_activity_at);
    const diff = now.getTime() - lastActive.getTime();
    return msToDays(diff) > inactiveDays;
  }).sort((a, b) => (
    a.last_activity_at === null || a.last_activity_at === undefined || b.last_activity_at === null || b.last_activity_at === undefined ?
    -1 : new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()
  ));

  core.info(`Found ${inactiveSeats.length} inactive seats`);
  core.debug(JSON.stringify(inactiveSeats, null, 2));

  const inactiveSeatsWithOrg = inactiveSeats.map(seat => ({ ...seat, organization: org } as SeatWithOrg));

  // Save inactive seat data to the orgData map and return inactive seats
  const orgDataEntry = orgData.get(org) || {};
  orgData.set(org, { ...orgDataEntry, inactiveSeats: inactiveSeatsWithOrg });

  return inactiveSeatsWithOrg;

}


export function getInputs(): Input {
  const result = {} as Input;
  result.token = core.getInput('github-token');
  result.org = core.getInput('organization');
  result.enterprise = core.getInput('enterprise');
  result.removeInactive = core.getBooleanInput('remove');
  result.removefromTeam = core.getBooleanInput('remove-from-team');
  result.inactiveDays = parseInt(core.getInput('inactive-days'));
  result.jobSummary = core.getBooleanInput('job-summary');
  result.csv = core.getBooleanInput('csv');
  result.deployUsers = core.getBooleanInput('deploy-users');
  result.deployUsersDryRun = core.getBooleanInput('deploy-users-dry-run');
  result.deployUsersCsv = core.getInput('deploy-users-csv');
  result.deployValidationTime = parseInt(core.getInput('deploy-validation-time'));
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  let organizations: string[] = [];
  let hasNextPage = false;
  let afterCursor: string | undefined = undefined;
  let allInactiveSeats: SeatWithOrg[] = [];
  let allRemovedSeatsCount = 0;
  let allSeatsCount = 0;

  const octokit = github.getOctokit(input.token);

  if (input.enterprise && input.enterprise !== null) {
    core.info(`Fetching all organizations for ${input.enterprise}...`);

    // Fetch all organizations in the enterprise
    interface GraphQlResponse {
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
    }

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
      const response: GraphQlResponse = await octokit.graphql<GraphQlResponse>(query, variables);
      organizations = organizations.concat(response.enterprise.organizations.nodes.map(org => org.login));

      hasNextPage = response.enterprise.organizations.pageInfo.hasNextPage;
      afterCursor = response.enterprise.organizations.pageInfo.endCursor;
      
    } while (hasNextPage);

    core.info(`Found ${organizations.length} organizations.`);
    core.debug(`Organization List: ${organizations.join(', ')}`);
  } else {
    // Split org input by comma (to allow multiple orgs)
    organizations = input.org.split(',').map(org => org.trim());
  }


  for (const org of organizations) {
    const seats = await getOrgData(org, octokit);

    const inactiveSeats = getInactiveSeats(org, seats, input.inactiveDays);

    allInactiveSeats = [...allInactiveSeats, ...inactiveSeats];
    allSeatsCount += seats.length;

    if (input.removeInactive) {
      const inactiveSeatsAssignedIndividually = inactiveSeats.filter(seat => !seat.assigning_team);
      if (inactiveSeatsAssignedIndividually.length > 0) {
        await core.group('Removing inactive seats', async () => {
          const response = await octokit.request(`DELETE /orgs/{org}/copilot/billing/selected_users`, {
            org: org,
            selected_usernames: inactiveSeatsAssignedIndividually.map(seat => seat.assignee.login),
          });
          core.info(`Removed ${response.data.seats_cancelled} seats`);
          allRemovedSeatsCount += response.data.seats_cancelled;
          core.info(`removed users:  ${inactiveSeatsAssignedIndividually.map(seat => seat.assignee.login)}`)
        });
      }
    }

    if (input.removefromTeam) {
      const inactiveSeatsAssignedByTeam = inactiveSeats.filter(seat => seat.assigning_team);
      await core.group('Removing inactive seats from team', async () => {
        for (const seat of inactiveSeatsAssignedByTeam) {
          if (!seat.assigning_team || typeof(seat.assignee.login) !== 'string') continue;

          const response = await octokit.request(`GET /orgs/{org}/teams/{team_slug}/memberships/{username}`, {
            org: org,
            team_slug: seat.assigning_team.slug,
            username: seat.assignee.login
          });
          core.debug(`User ${seat.assignee.login} has ${response.data.role} role on team ${seat.assigning_team.slug}`)

          if (response.data.role === 'maintainer'){
            core.info(`User ${seat.assignee.login} is maintainer, skipping removal`)
            continue
          }

          await octokit.request('DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}', {
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
        .addHeading(`${org} - Inactive Seats: ${inactiveSeats.length.toString()} / ${seats.length.toString()}`)
        if (seats.length > 0) {
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

  if (input.deployUsers) {
    core.info(`Fetching all deployment information from CSV ${input.deployUsersCsv}...`);
    deployment(input);
  }

  if (input.csv) {
    core.group('Writing CSV', async () => {
      const sortedSeats = allInactiveSeats.sort((a, b) => {
        return a.organization.localeCompare(b.organization) || a.assignee.login.localeCompare(b.assignee.login);
      });

      const csv = [
        ['Organization', 'Login', 'Last Activity', 'Last Editor Used'],
        ...sortedSeats.map(seat => [
          seat.organization,
          seat.assignee.login,
          seat.last_activity_at === null ? 'No activity' : momemt(seat.last_activity_at).fromNow(),
          seat.last_activity_editor || '-'
        ])
      ].map(row => row.join(',')).join('\n');
      writeFileSync('inactive-seats.csv', csv);
      const artifactClient = artifact.create();
      await artifactClient.uploadArtifact('inactive-seats', ['inactive-seats.csv'], '.');
    });
  }

  core.setOutput('inactive-seats', JSON.stringify(allInactiveSeats));
  core.setOutput('inactive-seat-count', allInactiveSeats.length.toString());
  core.setOutput('seat-count', allSeatsCount.toString());
  core.setOutput('removed-seats', allRemovedSeatsCount.toString());
  core.setOutput('deployed-seats', JSON.stringify(deployedSeats));
  core.setOutput('deployed-seat-count', deployedSeatsCount.toString());
};

run();
