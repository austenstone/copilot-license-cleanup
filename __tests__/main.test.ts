import * as process from 'process';
import * as cp from 'child_process';
import * as path from 'path';
import { test } from '@jest/globals';

const addInput = (key, value) => {
  process.env[`INPUT_${key.replace(/ /g, '-').toUpperCase()}`] = value;
}

const input: any = {
  'github-token': process.env.GITHUB_TOKEN,
  organization: process.env.ORGANIZATION || 'octoaustenstone',
  'inactive-days': process.env.INACTIVE_DAYS || '30',
  remove: process.env.REMOVE || true,
  'job-summary': process.env.JOB_SUMMARY || false,
}

test('test run', () => {
  Object.entries(input).forEach(([key, value]) => addInput(key, value));
  process.env['GITHUB_REPOSITORY'] = 'austenstone/copilot-license-cleanup';
  const np = process.execPath;
  const ip = path.join(__dirname, '..', 'dist', 'index.js');
  const options: cp.ExecFileSyncOptions = {
    env: process.env,
  };
  console.log(cp.execFileSync(np, [ip], options).toString());
});