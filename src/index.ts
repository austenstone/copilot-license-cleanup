import * as core from '@actions/core';
import * as github from '@actions/github';

interface Input {
  token: string;
  org: string;
}

export function getInputs(): Input {
  const result = {} as Input;
  result.token = core.getInput('github-token');
  result.org = core.getInput('organization');
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  const octokit = github.getOctokit(input.token);

  let seats: any[] = [];
  let expectedSeats = 0, page = 1;
  do {
    const response = await octokit.request(`GET /orgs/{org}/copilot/billing/seats?per_page=100&page=${page}`, {
      org: input.org
    });
    expectedSeats = response.data.total_seats;
    seats = seats.concat(response.data.seats);
    page++;
  } while (seats.length < expectedSeats);

  const now = new Date();
  let inactiveSeats = seats.filter(seat => {
    if (seat.last_activity_at === null) return true;
    const lastActive = new Date(seat.last_activity_at);
    const diff = now.getTime() - lastActive.getTime();
    const diffDays = Math.ceil(diff / (1000 * 3600 * 24));
    return diffDays > 30;
  }).sort((a, b) => (a.last_activity_at === null ? -1 : new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()));

  await core.summary
    .addHeading("Inactive Seats")
    .addRaw(`Inactive Seats: ${inactiveSeats.length.toString()} / ${seats.length.toString()}\n`)
    .addTable([
      [
        { data: 'Login', header: true },
        { data: 'Last Active', header: true }
      ],
      ...inactiveSeats.map(seat => [
        seat.assignee.login || '????',
        seat.last_activity_at || 'Never'
      ])
    ])
    .addLink('View GitHub Copilot seats!', `https://github.com/organizations/${github.context.repo.owner}/settings/copilot/seat_management`)
    .write()
};

run();