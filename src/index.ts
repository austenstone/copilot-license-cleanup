import * as core from '@actions/core';
import * as github from '@actions/github';

interface Input {
  token: string;
}

export function getInputs(): Input {
  const result = {} as Input;
  result.token = core.getInput('github-token');
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  const octokit = github.getOctokit(input.token);

  let seats: any[] = [];
  let expectedSeats = 0, page = 0;
  do {
    const response = await octokit.request(`GET /orgs/{org}/copilot/billing/seats?per_page=100&page=${page}`, {
      org: "octodemo"
    });
    expectedSeats = response.data.total_seats;
    seats = seats.concat(response.data.seats);
    page++;
  } while (seats.length < expectedSeats);

  const now = new Date();
  const inactiveSeats = seats.filter(seat => {
    if (seat.last_activity_at === null) return true;
    const lastActive = new Date(seat.last_activity_at);
    const diff = now.getTime() - lastActive.getTime();
    const diffDays = Math.ceil(diff / (1000 * 3600 * 24));
    return diffDays > 30;
  });

  console.log(inactiveSeats);

  await core.summary
    .addHeading("Inactive Seats")
    .addDetails("Total Seats", seats.length.toString())
    .addDetails("Inactive Seats", inactiveSeats.length.toString())
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