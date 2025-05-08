import * as process from 'process';
import * as cp from 'child_process';
import * as path from 'path';
import { test } from '@jest/globals';

const addInput = (key, value) => {
  process.env[`INPUT_${key.replace(/ /g, '-').toUpperCase()}`] = value;
}

const input: any = {
  'github-token': process.env.GITHUB_TOKEN,
  'organization': process.env.ORGANIZATION || 'austenstone',
  'inactive-days': process.env.INACTIVE_DAYS || '30',
  'remove': process.env.REMOVE || false,
  'remove-from-team': process.env.REMOVE_FROM_TEAM || false,
  'job-summary': process.env.JOB_SUMMARY || false,
  'csv': process.env.CSV || false,
  'allowlist': process.env.ALLOWLIST || 'user1,user2',
}

test('test run', () => {
  Object.entries(input).forEach(([key, value]) => addInput(key, value));
  process.env['GITHUB_REPOSITORY'] = 'austenstone/copilot-license-cleanup';
  const np = process.execPath;
  const ip = path.join(__dirname, '..', 'dist', 'index.js');
  const options: cp.ExecFileSyncOptions = {
    env: process.env,
  };

  const spawned = cp.spawnSync(np, [ip], options);
  console.log(spawned.stdout.toString());
});

test('allowlist functionality', () => {
  // Set up test environment with allowlist
  const testInput = { ...input, 'allowlist': 'testuser1,testuser2', 'remove': true };
  Object.entries(testInput).forEach(([key, value]) => addInput(key, value));
  process.env['GITHUB_REPOSITORY'] = 'austenstone/copilot-license-cleanup';

  const np = process.execPath;
  const ip = path.join(__dirname, '..', 'dist', 'index.js');
  const options: cp.ExecFileSyncOptions = {
    env: process.env,
  };

  const spawned = cp.spawnSync(np, [ip], options);
  const output = spawned.stdout.toString();
  console.log(output);

  // Verify that users in allowlist are not removed
  expect(output).toContain('Skipping removal');
  expect(output).toContain('testuser1');
  expect(output).toContain('testuser2');
});
