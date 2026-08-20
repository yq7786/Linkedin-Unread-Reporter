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

function privateStat({ dev = 1, ino = 2, mode = 0o100600, isFile = true } = {}) {
  return { dev, ino, mode, isFile: () => isFile };
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

test('configurePortal stores an unwrapped chat-pasted markdown webhook URL', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const answers = [
      '[https://portal.example.test/hooks/linkedin](https://portal.example.test/hooks/linkedin)',
      'private-call-secret',
    ];

    await configurePortal({ envPath, askSecret: async () => answers.shift() });
    const text = await fs.readFile(envPath, 'utf8');
    assert.match(text, /^PORTAL_WEBHOOK_URL=https:\/\/portal\.example\.test\/hooks\/linkedin$/m);
    assert.doesNotMatch(text, /\[https:/);
  });
});

test('configurePortal reports a skill directory that cannot be written without leaking paths', async () => {
  const answers = [
    'https://portal.example.test/hooks/linkedin',
    'private-call-secret',
  ];
  const permissionError = new Error('EPERM: operation not permitted, open \'/private/project/.env.tmp-1\'');
  permissionError.code = 'EPERM';
  const fileSystem = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    open: async () => {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
    writeFile: async () => { throw permissionError; },
    chmod: async () => {},
    rename: async () => {},
    rm: async () => {},
  };

  await assert.rejects(configurePortal({
    envPath: '/private/project/.env',
    askSecret: async () => answers.shift(),
    fileSystem,
    processId: 1,
  }), (error) => error.message === 'The skill directory is not writable. Rerun `npm run configure` with write access to the installed skill directory.'
    && !error.message.includes('/private/project')
    && !error.message.includes('portal.example.test')
    && !error.message.includes('private-call-secret'));
});

test('configurePortal atomically stores portal values and preserves unrelated env lines', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const opaqueLegacyLine = `${[['SLA', 'CK'].join(''), 'WEBHOOK_URL'].join('_')}=opaque-value`;
    await fs.writeFile(envPath, `${opaqueLegacyLine}\n`, 'utf8');
    await fs.chmod(envPath, 0o600);
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

test('configurePortal creates an exact mode-0600 env under a restrictive umask', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const answers = [
      'https://portal.example.test/hooks/linkedin',
      'private-call-secret',
    ];
    const previousUmask = process.umask(0o777);
    try {
      await configurePortal({ envPath, askSecret: async () => answers.shift() });
    } finally {
      process.umask(previousUmask);
    }

    assert.equal((await fs.stat(envPath)).mode & 0o7777, 0o600);
  });
});

test('configurePortal rejects unsafe raw URL characters before changing the env file', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const originalText = 'CUSTOM=preserved\n';
    await fs.writeFile(envPath, originalText, 'utf8');
    await fs.chmod(envPath, 0o600);
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
      await fs.chmod(envPath, 0o600);
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
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    open: async () => ({
      stat: async () => privateStat(),
      readFile: async () => `${[['SLA', 'CK'].join(''), 'WEBHOOK_URL'].join('_')}=opaque-value\n`,
      close: async () => {},
    }),
    lstat: async () => privateStat(),
    writeFile: async (_target, text) => { writtenText = text; },
    chmod: async () => {},
    rename: async () => { throw new Error('rename failed'); },
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

test('configurePortal securely preserves a valid existing env without chmod remediation', async () => {
  const calls = [];
  const answers = ['https://portal.example.test/hooks/linkedin', 'private-call-secret'];
  const handle = {
    stat: async () => { calls.push(['handle.stat']); return privateStat(); },
    readFile: async (...args) => { calls.push(['handle.readFile', ...args]); return 'CUSTOM=preserved\n'; },
    close: async () => { calls.push(['handle.close']); },
  };
  const fileSystem = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    open: async (...args) => { calls.push(['open', ...args]); return handle; },
    lstat: async (...args) => { calls.push(['lstat', ...args]); return privateStat(); },
    writeFile: async (...args) => { calls.push(['writeFile', ...args]); },
    chmod: async (...args) => { calls.push(['chmod', ...args]); },
    rename: async (...args) => { calls.push(['rename', ...args]); },
    rm: async (...args) => { calls.push(['rm', ...args]); },
  };

  await configurePortal({
    envPath: '/private/project/.env',
    askSecret: async () => answers.shift(),
    fileSystem,
    processId: 42,
  });

  assert.deepEqual(calls.slice(0, 5), [
    ['open', '/private/project/.env', 0x20000],
    ['handle.stat'],
    ['handle.readFile', 'utf8'],
    ['lstat', '/private/project/.env'],
    ['handle.close'],
  ]);
  assert.equal(calls.some((call) => (
    call[0] === 'chmod' && call[1] === '/private/project/.env'
  )), false);
  assert.deepEqual(calls.at(-3), [
    'chmod',
    '/private/project/.env.tmp-42',
    0o600,
  ]);
  assert.deepEqual(calls.at(-2), [
    'rename',
    '/private/project/.env.tmp-42',
    '/private/project/.env',
  ]);
  assert.deepEqual(calls.at(-1), [
    'rm',
    '/private/project/.env.tmp-42',
    { force: true },
  ]);
});

test('configurePortal rejects unsafe existing env files without changing them or leaking details', async () => {
  await withTempDirectory(async (directory) => {
    const envPath = path.join(directory, '.env');
    const privateContent = 'CUSTOM=must-not-leak\n';
    const answersFor = () => ['https://portal.example.test/hooks/linkedin', 'private-call-secret'];

    await fs.writeFile(envPath, privateContent, { mode: 0o644 });
    let answers = answersFor();
    await assert.rejects(configurePortal({
      envPath,
      askSecret: async () => answers.shift(),
    }), (error) => error.message === 'Environment file could not be read securely.'
      && !error.message.includes(privateContent.trim())
      && !error.message.includes(directory));
    assert.equal(await fs.readFile(envPath, 'utf8'), privateContent);

    await fs.unlink(envPath);
    const targetPath = path.join(directory, 'must-not-leak.env');
    await fs.writeFile(targetPath, privateContent, { mode: 0o600 });
    await fs.symlink(targetPath, envPath);
    answers = answersFor();
    await assert.rejects(configurePortal({
      envPath,
      askSecret: async () => answers.shift(),
    }), (error) => error.message === 'Environment file could not be read securely.'
      && !error.message.includes(privateContent.trim())
      && !error.message.includes(directory));
    assert.equal(await fs.readFile(targetPath, 'utf8'), privateContent);
  });
});

test('configurePortal fails closed on no-follow absence and path replacement before writing', async () => {
  for (const fileSystem of [
    { constants: { O_RDONLY: 0 }, open: async () => assert.fail() },
    {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      open: async () => ({
        stat: async () => privateStat({ ino: 2 }),
        readFile: async () => 'CUSTOM=must-not-leak\n',
        close: async () => {},
      }),
      lstat: async () => privateStat({ ino: 3 }),
    },
  ]) {
    const answers = ['https://portal.example.test/hooks/linkedin', 'private-call-secret'];
    await assert.rejects(configurePortal({
      envPath: '/private/project/.env',
      askSecret: async () => answers.shift(),
      fileSystem,
    }), (error) => error.message === 'Environment file could not be read securely.'
      && !error.message.includes('must-not-leak')
      && !error.message.includes('/private/project'));
  }
});
