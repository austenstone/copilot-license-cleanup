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
  try {
    const input = getInputs();
    const octokit = github.getOctokit(input.token);

    const seats = await octokit.paginate("GET /orgs/{org}/copilot/billing/seats", {
      org: "octodemo",
    });

    console.log(seats);
  } catch (error) {
    core.startGroup(error instanceof Error ? error.message : JSON.stringify(error));
    core.info(JSON.stringify(error, null, 2));
    core.endGroup();
  }
};

run();