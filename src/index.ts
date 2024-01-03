import * as core from '@actions/core';
import * as github from '@actions/github';
import momemt from 'moment';
import { writeFileSync } from 'fs';
import * as artifact from '@actions/artifact';
import type { Endpoints } from "@octokit/types";
import { SummaryTableRow } from '@actions/core/lib/summary';
import { RequestError } from '@octokit/request-error';

interface Input {
  token: string;
  org: string;
  enterprise: string;
  removeInactive: boolean;
  removefromTeam: boolean;
  inactiveDays: number;
  jobSummary: boolean;
  csv: boolean;
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
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  let organizations: string[];
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
        };
      };
    }

    const query = `
      query ($enterprise: String!) {
        enterprise(slug: $enterprise) {
          organizations(first: 100) {
            nodes {
              login
            }
          }
        }
      }
    `;

    const variables = { enterprise: input.enterprise };

    const response = await octokit.graphql<GraphQlResponse>(query, variables);

    organizations = response.enterprise.organizations.nodes.map(org => org.login);
    core.info(`Found ${organizations.length} organizations: ${organizations.join(', ')}`);

  } else {
    // Split org input by comma (to allow multiple orgs)
    organizations = input.org.split(',').map(org => org.trim());
  }


  for (const org of organizations) {
    // Process each organization
    const seats = await core.group('Fetching GitHub Copilot seats for ' + org, async () => {

      // No type exists for copilot endpoint yet
      let _seats: Endpoints["GET /orgs/{org}/copilot/billing/seats"]["response"]['data']['seats'] = [], totalSeats = 0, page = 1;
      do {
        try {
          const response = await octokit.request(`GET /orgs/{org}/copilot/billing/seats?per_page=100&page=${page}`, {
            org: org
          });
          totalSeats = response.data.total_seats;
          _seats = _seats.concat(response.data.seats);
          page++;
        } catch (error) {
          if (error instanceof RequestError && error.message === "Copilot Business is not enabled for this organization.") {
            core.error((error as Error).message + ` (${org})`);
            break;
          } else {
            throw error;
          }
        }
      } while (_seats.length < totalSeats);
      core.info(`Found ${_seats.length} seats`)
      core.info(JSON.stringify(_seats, null, 2));
      return _seats;
    });

    const msToDays = (d) => Math.ceil(d / (1000 * 3600 * 24));

    const now = new Date();
    const inactiveSeats = seats.filter(seat => {
      if (seat.last_activity_at === null || seat.last_activity_at === undefined) {
        const created = new Date(seat.created_at);
        const diff = now.getTime() - created.getTime();
        return msToDays(diff) > input.inactiveDays;
      }
      const lastActive = new Date(seat.last_activity_at);
      const diff = now.getTime() - lastActive.getTime();
      return msToDays(diff) > input.inactiveDays;
    }).sort((a, b) => (
      a.last_activity_at === null || a.last_activity_at === undefined || b.last_activity_at === null || b.last_activity_at === undefined ?
      -1 : new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()
    ));

    core.setOutput('inactive-seats', JSON.stringify(inactiveSeats));
    core.setOutput('inactive-seat-count', inactiveSeats.length.toString());
    core.setOutput('seat-count', seats.length.toString());

    if (input.removeInactive) {
      const inactiveSeatsAssignedIndividually = inactiveSeats.filter(seat => !seat.assigning_team);
      if (inactiveSeatsAssignedIndividually.length > 0) {
        core.group('Removing inactive seats', async () => {
          const response = await octokit.request(`DELETE /orgs/{org}/copilot/billing/selected_users`, {
            org: org,
            selected_usernames: inactiveSeatsAssignedIndividually.map(seat => seat.assignee.login),
          });
          core.info(`Removed ${response.data.seats_cancelled} seats`);
          core.setOutput('removed-seats', response.data.seats_cancelled);
        });
      }
    }

    if (input.removefromTeam) {
      const inactiveSeatsAssignedByTeam = inactiveSeats.filter(seat => seat.assigning_team);
      core.group('Removing inactive seats from team', async () => {
        for (const seat of inactiveSeatsAssignedByTeam) {
          if (!seat.assigning_team || typeof(seat.assignee.login) !== 'string') continue;
          await octokit.request('DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}', {
            org: org,
            team_slug: seat.assigning_team.slug,
            username: seat.assignee.login
          })
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

    if (input.csv) {
      core.group('Writing CSV', async () => {
        const csv = [
          ['Login', 'Last Activity', 'Last Editor Used'],
          ...inactiveSeats.map(seat => [
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
  }
};

run();
