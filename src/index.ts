import * as core from '@actions/core';
import * as github from '@actions/github';
import momemt from 'moment';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
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

type UserList = {
  organization: string;
  deployment_group: string;
  login: string;
  activation_date: string;
};

// Needed to pass the Octokit type from @actions/github to other functions
type Octokit = ReturnType<typeof github.getOctokit>;

// Create a Map to store data per organization
const orgData = new Map();  // Map<org, { seats: [], inactiveSeats: [] }>

// Function to get all seats in an organization
// Returns an array of seats 
async function getOrgData(org: string, octokit: Octokit) {
  const seats = await core.group('Fetching GitHub Copilot seats for ' + org, async () => {

    // No type exists for copilot endpoint yet
    let _seats: Endpoints["GET /orgs/{org}/copilot/billing/seats"]["response"]['data']['seats'] = [], totalSeats = 0, page = 1;
    try { 
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
          } else if (error instanceof RequestError && error.status === 404) {
            core.error((error as Error).message + ` (${org}).  Please ensure that the organization has GitHub Copilot enabled and you are an org owner.`);
            break;
          } else {
            throw error;
          }
        }
      } while (_seats.length < totalSeats);
      core.info(`Found ${_seats.length} seats`)
      core.debug(JSON.stringify(_seats, null, 2));
    } finally {
      // Close Actions core.group
      core.endGroup();
    }
    return _seats;
  });

  // Save seat data to the orgData Map by org id and then return seats
  orgData.set(org, { seats: seats });
  return seats;

}

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

// Function to get all members in an organization
// Returns an array of seats 
async function getOrgMembers(org: string, octokit: Octokit) {
  const members = await core.group('Fetching GitHub Organization Members for ' + org, async () => {
    let members = [];
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const response = await octokit.request(`GET /orgs/${org}/members?per_page=100&page=${page}`);
        if (response.data.length === 0) {
          break;
        }
        members = members.concat(response.data);
        page++;
      } catch (error) {
        if (error instanceof RequestError && error.name === "HttpError" && error.message === "Not Found") {
          core.error(`Organization (${org}) not found.  Please check that the organization exists and you are an org owner.`);
          break;
        } else {
          throw error;
        }
      }
    }

    core.info(`Found ${members.length} members`)
    core.debug(JSON.stringify(members, null, 2));
    return members;
  });

  // Save existing orgData and append member data to the orgData Map by org id and then return members
  const orgDataEntry = orgData.get(org) || {};
  orgData.set(org, { ...orgDataEntry, members: members });
  return members;

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
  const deployedSeats: UserList[] = [];
  let deployedSeatsCount = 0;

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
      const response = await octokit.graphql<GraphQlResponse>(query, variables);
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
    // Process each organization
    const seats = await getOrgData(org, octokit);

    const inactiveSeats = getInactiveSeats(org, seats, input.inactiveDays);

    allInactiveSeats = [...allInactiveSeats, ...inactiveSeats];
    allSeatsCount += seats.length;

    if (input.removeInactive) {
      const inactiveSeatsAssignedIndividually = inactiveSeats.filter(seat => !seat.assigning_team);
      if (inactiveSeatsAssignedIndividually.length > 0) {
        core.group('Removing inactive seats', async () => {
          const response = await octokit.request(`DELETE /orgs/{org}/copilot/billing/selected_users`, {
            org: org,
            selected_usernames: inactiveSeatsAssignedIndividually.map(seat => seat.assignee.login),
          });
          core.info(`Removed ${response.data.seats_cancelled} seats`);
          console.log(typeof response.data.seats_cancelled);
          allRemovedSeatsCount += response.data.seats_cancelled;
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
  }

  if (input.deployUsers) {
    core.info(`Fetching all deployment information from CSV ${input.deployUsersCsv}...`);
    // Get users from deployUsersCsv Input
    
    try {  
      const csvFilePath = path.resolve(process.env.GITHUB_WORKSPACE || __dirname, input.deployUsersCsv);
    
      // Check if the file exists before trying to read it
      if (!existsSync(csvFilePath)) {
        core.setFailed(`File not found: ${csvFilePath}`);
        return;
      }
    
      const fileContent = readFileSync(csvFilePath, { encoding: 'utf-8' });
      core.debug(`File content: ${fileContent}`)

      const records: UserList[] = parse(fileContent, { 
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });

      const usersToDeploy: UserList[] = records.filter(record => {
        core.debug(`Record: ${JSON.stringify(record)}`);

        // Check for empty values
        const hasEmptyValues = Object.values(record).some(value => value === '');
        
        // Check for valid date
        const date = new Date(record.activation_date);
        const hasInvalidDate = isNaN(date.getTime());
        
        if (hasEmptyValues || hasInvalidDate) {
          core.error(`Skipping record with ${hasEmptyValues ? 'empty values' : 'invalid date'}: ${JSON.stringify(record)}`);
          return false;
        } else {
          
          // Check that record.activation_date is within input.deployValidationTime days from today.
          const today = new Date();
          const currentTime = today.getTime();
          const validationTime = today.setDate(today.getDate() - input.deployValidationTime);
          const activationTime = date.getTime();  // date = record.activation_date
          const isDateWithinWindow = validationTime <= activationTime  && activationTime <= currentTime;

          if (!isDateWithinWindow) {
            core.info(`Skipping record due to activation date outside ${input.deployValidationTime} day window: ${JSON.stringify(record)}`);
            return false;
          }

          // Record is good and within deployment date window.  Add to usersToDeploy array
          return true;
        }

      });

      core.info(`Found ${usersToDeploy.length} users to deploy.`);
      core.debug(JSON.stringify(usersToDeploy, null, 2));

      // Get members from each organization
      const uniqueOrganizations = new Set(usersToDeploy.map(user => user.organization));
      for (const organization of uniqueOrganizations) {
        try {
            const members = await getOrgMembers(organization, octokit);
            core.info(`Found ${members.length} members in ${organization}.`);
          } catch (error) {
            core.error(`Failed to fetch members for organization ${organization}: ${error}`);
          }
      }

      // Process users one at a time
      for (const user of usersToDeploy) {
        core.info(`Processing user for deployment: ${JSON.stringify(user)}`);

        // Check if the organization already exists in orgData
        if (!orgData.get(user.organization)) {
          // Organization not found in orgData.  Add it.
          core.info(`Organization Data not found for ${user.organization}.  Fetching...`);
          try {
            const seats = await getOrgData(user.organization, octokit);
            getInactiveSeats(user.organization, seats, input.inactiveDays);
          } catch (error) {
            core.error(`Failed to fetch data for organization ${user.organization}: ${error}`);
            continue;
          }
      
          // Confirm the org data was added
          if (!orgData.get(user.organization)) {
            core.error(`Organization not found: ${user.organization}`);
            continue;
          }
        } else {
          core.debug(`Organization Data found for ${user.organization}`);
        
          // Organization Exists - Check if the user exists in the organization
          if (user.login != orgData.get(user.organization)?.members.find(member => member.login === user.login)?.login) {
            // Note - Could do setFailed here, but it's not really a failure.  Just a warning.
            core.error(`User ${user.login} is not a member of ${user.organization}`);
            continue;

            /*
            // User not found in organization.  Add them.
            // https://docs.github.com/en/rest/orgs/members?apiVersion=2022-11-28#set-organization-membership-for-a-user
            await octokit.request('PUT /orgs/${org}/memberships/${username}', {
              role: 'member',
            });
            */
            
          } else {
            core.debug(`User ${user.login} is a member of ${user.organization}`);

            // Check if the user is already has a copilot seat and is not pending cancellation
            //if (orgData.get(user.organization)?.seats.find(seat => seat.assignee.login === user.login)) {
            core.debug(`Checking if user ${user.login} has a copilot seat in ${user.organization}`);
            core.debug(`orgData for ${user.organization}: ${JSON.stringify(orgData.get(user.organization), null, 2)}`);
            if ((orgData.get(user.organization)?.seats ?? []).find(seat => seat.assignee.login === user.login && seat.pending_cancellation_date === null)) {
              core.info(`User ${user.login} already has a copilot seat in ${user.organization}`);
              continue;
            } else {
              // Assign a copilot Seat to the user
              // https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-business?apiVersion=2022-11-28#add-users-to-the-copilot-business-subscription-for-an-organization
              if (!input.deployUsersDryRun) {
                core.info(`Assigning ${user.login} a Copilot seat in ${user.organization}`);
                try {
                  const response = await octokit.request(`POST /orgs/${user.organization}/copilot/billing/selected_users`, {
                    selected_usernames: [`${user.login}`]
                  });

                  core.info(`Added ${response.data.seats_created} seats`);
                  deployedSeatsCount += response.data.seats_created;
                  deployedSeats.push(user);

                } catch (error) {
                  if (error instanceof RequestError && error.message === "Copilot Business is not enabled for this organization.") {
                    core.error((error as Error).message + ` (${user.organization})`);
                  } else {
                    throw error;
                  }
                }
              } else {
                core.info(`DRY RUN: Would assign ${user.login} a Copilot seat in ${user.organization}`);
                deployedSeatsCount += 1;
                deployedSeats.push(user);
              }
            }
          }
        }
      }

      // Add Deployment Summary Output
      if (input.jobSummary) {
        await core.summary
          if (!input.deployUsersDryRun) {
            core.summary.addHeading(`Deployed Seats: ${deployedSeats.length.toString()}`)
          } else {
            core.summary.addHeading(`DRY RUN: Seats to deploy: ${deployedSeats.length.toString()}`)
          }
          if (deployedSeats.length > 0) {
            core.summary.addTable([
              [
                { data: 'Organization', header: true },
                { data: 'Group', header: true },
                { data: 'Login', header: true },
                { data: 'Activation Date', header: true }
              ],
              ...deployedSeats.sort((a, b) => {
                const loginA = (a.login || 'Unknown') as string;
                const loginB = (b.login || 'Unknown') as string;
                return loginA.localeCompare(loginB);
              }).map(seat => [
                seat.organization,
                seat.deployment_group,
                seat.login,
                seat.activation_date
              ] as SummaryTableRow)
            ])
          }

          // Add a summary of deployed users by group including number of users with a seat out of total users in the group
          interface Counts {
            total: number;
            deployed: number;
            inactive: number;
          }
          
          interface GroupCounts {
            [group: string]: Counts;
          }
          
          const groupCounts = records.reduce((counts: GroupCounts, record) => {
            if (!counts[record.deployment_group]) {
              counts[record.deployment_group] = { total: 0, deployed: 0, inactive: 0 };
            }
            counts[record.deployment_group].total++;
            // Add deployed count if the user previously had a seat
            if ((orgData.get(record.organization)?.seats ?? []).find(seat => seat.assignee.login === record.login && seat.pending_cancellation_date === null)) {
              counts[record.deployment_group].deployed++;
            }
            // Add net new deployed users from deployedSeats
            if (deployedSeats.find(seat => seat.login === record.login)) {
              counts[record.deployment_group].deployed++;
            }
            // Add inactive count if the user is inactive
            if (allInactiveSeats.find(seat => seat.assignee.login === record.login && seat.organization === record.organization)) {
              counts[record.deployment_group].inactive++;
            }
            return counts;
          }, {});

          const groupCountsArray = Object.entries(groupCounts)
            .sort((a, b) => a[0].localeCompare(b[0])) // Sort by group name
            .map(([group, counts]) => ({
              group,
              total: counts.total,
              deployed: counts.deployed,
              inactive: counts.inactive
          }));

          core.debug(`Group Counts: ${JSON.stringify(groupCounts, null, 2)}`);

          if (!input.deployUsersDryRun) {
            core.summary.addHeading(`Deployment Status`)
          } else {
            core.summary.addHeading(`DRY RUN: Deployment Status`)
          }

          core.summary.addTable([
            [
              { data: 'Group', header: true },
              { data: 'Deployed Seats', header: true },
              { data: 'Total Seats', header: true },
              { data: 'Inactive Seats', header: true }
            ],
            ...groupCountsArray.map(grouprecord => [
              grouprecord.group,
              grouprecord.deployed.toString(),
              grouprecord.total.toString(),
              grouprecord.inactive.toString()
            ] as SummaryTableRow)
          ])

        core.summary.write();
      }

    } catch (err) {
      console.error(err);
    }

  }

  // Write CSV if requested (for all orgs)
  if (input.csv) {
    core.group('Writing CSV', async () => {
      // Sort by organization and then by login
      const sortedSeats = allInactiveSeats.sort((a, b) => {
        if (a.organization < b.organization) return -1;
        if (a.organization > b.organization) return 1;
        if (a.assignee.login < b.assignee.login) return -1;
        if (a.assignee.login > b.assignee.login) return 1;
        return 0;
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

  // Set Outputs:
  core.setOutput('inactive-seats', JSON.stringify(allInactiveSeats));
  core.setOutput('inactive-seat-count', allInactiveSeats.length.toString());
  core.setOutput('seat-count', allSeatsCount.toString());
  core.setOutput('removed-seats', allRemovedSeatsCount.toString());
  core.setOutput('deployed-seats', JSON.stringify(deployedSeats));
  core.setOutput('deployed-seat-count', deployedSeatsCount.toString());
};

run();
