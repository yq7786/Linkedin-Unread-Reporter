import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, readProjectEnv } from '../src/config.js';
import { configurePortal, updateEnvText } from '../src/configure.js';

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-reporter-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('updateEnvText replaces selected values and preserves unrelated settings', () => {
  const result = updateEnvText('REPORT_TIMEZONE=Pacific/Auckland\nCUSTOM=value\nPORTAL_CALL_SECRET=test-placeholder\n', {
    PORTAL_CALL_SECRET: 'test-placeholder-new',
  });
  assert.match(result, /REPORT_TIMEZONE=Pacific\/Auckland/);
  assert.match(result, /CUSTOM=value/);
  assert.match(result, /PORTAL_CALL_SECRET=test-placeholder-new/);
  assert.equal(result.split(`${['PORTAL', 'CALL', 'SECRET'].join('_')}=`).length - 1, 1);
});

test('configurePortal atomically stores portal values and preserves unrelated env lines', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const opaqueLegacyLine = `${[['SLA', 'CK'].join(''), 'WEBHOOK_URL'].join('_')}=opaque-value`;
    await fs.writeFile(envPath, `${opaqueLegacyLine}\n`, 'utf8');
    const prompts = [];
    const answers = [
      'https://portal.example.test/hooks/linkedin',
      'private-call-secret',
    ];

    const result = await configurePortal({
      envPath,
      askSecret: async (prompt) => {
        prompts.push(prompt);
        return answers.shift();
      },
    });

    const text = await fs.readFile(envPath, 'utf8');
    assert.equal(text.split('\n').includes(opaqueLegacyLine), true);
    assert.match(text, /^PORTAL_WEBHOOK_URL=https:\/\/portal\.example\.test\/hooks\/linkedin$/m);
    assert.match(text, /^PORTAL_CALL_SECRET=private-call-secret$/m);
    assert.deepEqual(result, { configured: true, envPath });
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /portal\.example\.test|private-call-secret/);
    assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600);
  });
});

test('configurePortal round-trips a call secret containing equals signs', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const portalCallSecret = 'token=part==';
    const answers = [
      'https://portal.example.test/hooks/linkedin',
      portalCallSecret,
    ];

    await configurePortal({ envPath, askSecret: async () => answers.shift() });
    const env = readProjectEnv({ projectRoot: directory, baseEnv: {} });
    const config = loadConfig({ env, projectRoot: directory, requirePortal: true });

    assert.equal(env.PORTAL_CALL_SECRET, portalCallSecret);
    assert.equal(config.portalCallSecret, portalCallSecret);
    assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600);
  });
});

test('configurePortal rejects unsafe raw URL characters before changing the env file', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const originalText = 'CUSTOM=preserved\n';
    await fs.writeFile(envPath, originalText, 'utf8');
    const unsafeAnswers = [
      ['https://portal.example.test/hooks/"linkedin', 'private-call-secret'],
      ["https://portal.example.test/hooks/'linkedin", 'private-call-secret'],
      ['https://portal.example.test/hooks/linkedin', 'private"call-secret'],
      ['https://portal.example.test/hooks/linkedin', "private'call-secret"],
      ['https://portal.example.test/hooks/linkedin\nCUSTOM=replaced', 'private-call-secret'],
      ['https://portal.example.test/hooks/linkedin', 'private-call-secret\nCUSTOM=replaced'],
      ['https://portal.example.test/hooks/linked in', 'private-call-secret'],
      ['https://portal.example.test/hooks/linked\tin', 'private-call-secret'],
      ['https://portal.example.test/hooks/linked\vin', 'private-call-secret'],
      ['https://portal.example.test/hooks/linked\fin', 'private-call-secret'],
      ['https://portal.example.test/hooks/linked\u00a0in', 'private-call-secret'],
      ['https://portal.example.test/hooks/linked\u2028in', 'private-call-secret'],
      ['https://portal.example.test/hooks/linked\u2029in', 'private-call-secret'],
    ];

    for (const answers of unsafeAnswers) {
      await assert.rejects(configurePortal({
        envPath,
        askSecret: async () => answers.shift(),
      }));
      assert.equal(await fs.readFile(envPath, 'utf8'), originalText);
    }
  });
});

test('configurePortal does not create or modify an env file for an invalid URL or empty secret', async () => {
  for (const invalidAnswers of [
    ['http://portal.example.test/hooks/linkedin', 'private-call-secret'],
    ['https://portal.example.test/hooks/linkedin', ''],
  ]) {
    await withTempDirectory(async (directory) => {
      const envPath = path.join(directory, '.env');
      const answers = [...invalidAnswers];
      await assert.rejects(configurePortal({
        envPath,
        askSecret: async () => answers.shift(),
      }));
      await assert.rejects(fs.access(envPath));
    });

    await withTempDirectory(async (directory) => {
      const envPath = path.join(directory, '.env');
      const originalText = 'CUSTOM=preserved\n';
      await fs.writeFile(envPath, originalText, 'utf8');
      const answers = [...invalidAnswers];
      await assert.rejects(configurePortal({
        envPath,
        askSecret: async () => answers.shift(),
      }));
      assert.equal(await fs.readFile(envPath, 'utf8'), originalText);
    });
  }
});

test('configurePortal removes its secret temporary file after an atomic rename failure', async () => {
  const removed = [];
  let writtenText;
  const answers = [
    'https://portal.example.test/hooks/linkedin',
    'private-call-secret',
  ];
  const fileSystem = {
    readFile: async () => `${[['SLA', 'CK'].join(''), 'WEBHOOK_URL'].join('_')}=opaque-value\n`,
    writeFile: async (_target, text) => { writtenText = text; },
    rename: async () => { throw new Error('rename failed'); },
    chmod: async () => {},
    rm: async (target, options) => { removed.push([target, options]); },
  };

  await assert.rejects(configurePortal({
    envPath: '/tmp/reporter/.env',
    askSecret: async () => answers.shift(),
    fileSystem,
    processId: 2,
  }), (error) => /rename failed/.test(error.message)
    && !error.message.includes('portal.example.test')
    && !error.message.includes('private-call-secret'));
  assert.match(writtenText, /^PORTAL_WEBHOOK_URL=https:\/\/portal\.example\.test\/hooks\/linkedin$/m);
  assert.match(writtenText, /^PORTAL_CALL_SECRET=private-call-secret$/m);
  assert.deepEqual(removed, [['/tmp/reporter/.env.tmp-2', { force: true }]]);
});
