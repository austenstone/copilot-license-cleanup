import * as core from '@actions/core';
import * as github from '@actions/github';
import momemt from 'moment';
import { writeFileSync } from 'fs';
import * as artifact from '@actions/artifact';

interface Input {
  token: string;
  org: string;
  removeInactive: boolean;
  inactiveDays: number;
  jobSummary: boolean;
  csv: boolean;
}

export function getInputs(): Input {
  const result = {} as Input;
  result.token = core.getInput('github-token');
  result.org = core.getInput('organization');
  result.removeInactive = core.getBooleanInput('remove');
  result.inactiveDays = parseInt(core.getInput('inactive-days'));
  result.jobSummary = core.getBooleanInput('job-summary');
  result.csv = core.getBooleanInput('csv');
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  const octokit = github.getOctokit(input.token);

  let seats = await core.group('Fetching GitHub Copilot seats', async () => {
    let _seats: any[] = [], totalSeats = 0, page = 1;
    do {
      const response = await octokit.request(`GET /orgs/{org}/copilot/billing/seats?per_page=100&page=${page}`, {
        org: input.org
      });
      totalSeats = response.data.total_seats;
      _seats = _seats.concat(response.data.seats);
      page++;
    } while (_seats.length < totalSeats);
    core.info(`Found ${_seats.length} seats`)
    core.info(JSON.stringify(_seats, null, 2));
    return _seats;
  });

  const now = new Date();
  let inactiveSeats = seats.filter(seat => {
    if (seat.last_activity_at === null) return true;
    const lastActive = new Date(seat.last_activity_at);
    const diff = now.getTime() - lastActive.getTime();
    const diffDays = Math.ceil(diff / (1000 * 3600 * 24));
    return diffDays > input.inactiveDays;
  }).sort((a, b) => (a.last_activity_at === null ? -1 : new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()));

  // temp
  inactiveSeats = inactiveSeats.filter((seat) => seat.last_activity_at !== null);

  core.setOutput('inactive-seats', JSON.stringify(inactiveSeats));
  core.setOutput('inactive-seat-count', inactiveSeats.length.toString());
  core.setOutput('seat-count', seats.length.toString());

  if (input.removeInactive) {
    core.group('Removing inactive seats', async () => {
      const response = await octokit.request(`DELETE /orgs/{org}/copilot/billing/selected_users`, {
        org: input.org,
        selected_usernames: inactiveSeats.map(seat => seat.assignee.login),
      });
      core.info(`Removed ${response.data.seats_cancelled} seats`);
      core.setOutput('removed-seats', response.data.seats_cancelled);
    });
  } else {
    core.setOutput('removed-seats', 0);
  }

  if (input.jobSummary) {
    await core.summary
      .addHeading(`Inactive Seats: ${inactiveSeats.length.toString()} / ${seats.length.toString()}`)
      .addTable([
        [
          { data: 'Avatar', header: true },
          { data: 'Login', header: true },
          { data: 'Last Activity', header: true },
          { data: 'Last Editor Used', header: true }
        ],
        ...inactiveSeats.map(seat => [
          `<img src="${seat.assignee.avatar_url}" width="33" />`,
          seat.assignee.login,
          seat.last_activity_at === null ? 'No activity' : momemt(seat.last_activity_at).fromNow(),
          seat.last_activity_editor || '-'
        ])
      ])
      .addLink('Manage GitHub Copilot seats', `https://github.com/organizations/${input.org}/settings/copilot/seat_management`)
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

};

run();