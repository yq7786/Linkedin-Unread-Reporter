import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configureSlack, updateEnvText } from '../src/configure.js';

const webhook = ['https://hooks.slack.com', 'services', 'AAA', 'BBB', 'CCC'].join('/');

test('updateEnvText replaces the webhook and preserves unrelated settings', () => {
  const result = updateEnvText('REPORT_TIMEZONE=Pacific/Auckland\nCUSTOM=value\nSLACK_WEBHOOK_URL=old\n', {
    SLACK_WEBHOOK_URL: webhook,
  });
  assert.match(result, /REPORT_TIMEZONE=Pacific\/Auckland/);
  assert.match(result, /CUSTOM=value/);
  assert.match(result, new RegExp(`SLACK_WEBHOOK_URL=${webhook}`));
  assert.equal((result.match(/SLACK_WEBHOOK_URL=/g) || []).length, 1);
});

test('configureSlack creates a private env file without returning the secret', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-reporter-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, '.env');
  const prompts = [];

  const result = await configureSlack({
    envPath,
    askSecret: async (prompt) => {
      prompts.push(prompt);
      return webhook;
    },
  });

  assert.deepEqual(result, { configured: true, envPath });
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /hooks\.slack\.com/);
  assert.match(await fs.readFile(envPath, 'utf8'), new RegExp(`SLACK_WEBHOOK_URL=${webhook}`));
  assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600);
});

test('configureSlack validates before writing and does not expose the supplied value', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-reporter-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, '.env');
  const invalidSecret = 'not-a-webhook-private-value';

  await assert.rejects(
    configureSlack({ envPath, askSecret: async () => invalidSecret }),
    (error) => !error.message.includes(invalidSecret),
  );
  await assert.rejects(fs.access(envPath));
});

test('configureSlack removes the secret temporary file after an atomic rename failure', async () => {
  const removed = [];
  const fileSystem = {
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    writeFile: async () => {},
    rename: async () => { throw new Error('rename failed'); },
    chmod: async () => {},
    rm: async (target, options) => { removed.push([target, options]); },
  };

  await assert.rejects(configureSlack({
    envPath: '/tmp/reporter/.env',
    askSecret: async () => webhook,
    fileSystem,
    processId: 1,
  }), /rename failed/);
  assert.deepEqual(removed, [['/tmp/reporter/.env.tmp-1', { force: true }]]);
});
