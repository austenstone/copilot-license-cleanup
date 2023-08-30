import * as process from 'process';
import * as cp from 'child_process';
import * as path from 'path';
import { test } from '@jest/globals';

test('test run', () => {
  process.env['INPUT_GITHUB-TOKEN'] = process.env.GITHUB_TOKEN;
  const np = process.execPath;
  const ip = path.join(__dirname, '..', 'dist', 'index.js');
  const options: cp.ExecFileSyncOptions = {
    env: process.env,
  };
  console.log(cp.execFileSync(np, [ip], options).toString());
});
