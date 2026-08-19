import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ConfigError,
  loadConfig,
  parseEnvText,
  readProjectEnv,
  redactSecrets,
} from '../src/config.js';

const validPortalUrl = 'https://portal.example.test/hooks/linkedin';
const validCallSecret = 'private-call-secret';

function privateStat({ dev = 1, ino = 2, mode = 0o100600, isFile = true } = {}) {
  return { dev, ino, mode, isFile: () => isFile };
}

test('readProjectEnv reads a private regular file through one no-follow handle', () => {
  const calls = [];
  const fileSystem = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    openSync: (...args) => { calls.push(['openSync', ...args]); return 17; },
    fstatSync: (...args) => { calls.push(['fstatSync', ...args]); return privateStat(); },
    readFileSync: (...args) => { calls.push(['readFileSync', ...args]); return 'PRIVATE=value\n'; },
    lstatSync: (...args) => { calls.push(['lstatSync', ...args]); return privateStat(); },
    closeSync: (...args) => { calls.push(['closeSync', ...args]); },
  };

  assert.deepEqual(readProjectEnv({
    projectRoot: '/private/project',
    baseEnv: { PUBLIC: 'base' },
    fileSystem,
  }), { PRIVATE: 'value', PUBLIC: 'base' });
  assert.deepEqual(calls, [
    ['openSync', '/private/project/.env', 0x20000],
    ['fstatSync', 17],
    ['readFileSync', 17, 'utf8'],
    ['lstatSync', '/private/project/.env'],
    ['closeSync', 17],
  ]);
});

test('readProjectEnv preserves missing-file behavior and fails closed without O_NOFOLLOW', () => {
  const missing = new Error('private missing path');
  missing.code = 'ENOENT';
  assert.deepEqual(readProjectEnv({
    projectRoot: '/private/project',
    baseEnv: { PUBLIC: 'base' },
    fileSystem: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      openSync: () => { throw missing; },
    },
  }), { PUBLIC: 'base' });

  assert.throws(() => readProjectEnv({
    projectRoot: '/private/project',
    baseEnv: {},
    fileSystem: { constants: { O_RDONLY: 0 }, openSync: assert.fail },
  }), (error) => error.message === 'Environment file could not be read securely.');
});

test('readProjectEnv rejects symlinks, directories, broad permissions, and replacement races safely', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-env-hardening-'));
  const privateContent = 'PRIVATE_ENV_CONTENT=must-not-leak';
  const privatePath = path.join(directory, 'must-not-leak.env');
  const envPath = path.join(directory, '.env');
  try {
    fs.writeFileSync(privatePath, privateContent, { mode: 0o600 });
    fs.symlinkSync(privatePath, envPath);
    assert.throws(
      () => readProjectEnv({ projectRoot: directory, baseEnv: {} }),
      (error) => error.message === 'Environment file could not be read securely.'
        && !error.message.includes(privateContent)
        && !error.message.includes(directory),
    );
    fs.unlinkSync(envPath);

    fs.mkdirSync(envPath);
    assert.throws(
      () => readProjectEnv({ projectRoot: directory, baseEnv: {} }),
      (error) => error.message === 'Environment file could not be read securely.',
    );
    fs.rmdirSync(envPath);

    fs.writeFileSync(envPath, privateContent, { mode: 0o644 });
    assert.throws(
      () => readProjectEnv({ projectRoot: directory, baseEnv: {} }),
      (error) => error.message === 'Environment file could not be read securely.'
        && !error.message.includes(privateContent)
        && !error.message.includes(directory),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  let closed = false;
  assert.throws(() => readProjectEnv({
    projectRoot: '/private/project',
    baseEnv: {},
    fileSystem: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      openSync: () => 17,
      fstatSync: () => privateStat({ ino: 2 }),
      readFileSync: () => privateContent,
      lstatSync: () => privateStat({ ino: 3 }),
      closeSync: () => { closed = true; },
    },
  }), (error) => error.message === 'Environment file could not be read securely.'
    && !error.message.includes(privateContent)
    && !error.message.includes('/private/project'));
  assert.equal(closed, true);
});

test('readProjectEnv closes once and preserves a primary failure over close failure', () => {
  const calls = [];
  const privateContent = 'PRIVATE_ENV_CONTENT=must-not-leak';
  assert.throws(() => readProjectEnv({
    projectRoot: '/private/project',
    baseEnv: {},
    fileSystem: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      openSync: () => 17,
      fstatSync: () => privateStat(),
      readFileSync: () => { calls.push('read'); throw new Error(privateContent); },
      lstatSync: () => { calls.push('lstat'); return privateStat(); },
      closeSync: () => { calls.push('close'); throw new Error('private close failure'); },
    },
  }), (error) => error.message === 'Environment file could not be read securely.'
    && !error.message.includes(privateContent)
    && !error.message.includes('/private/project'));
  assert.deepEqual(calls, ['read', 'close']);

  assert.throws(() => readProjectEnv({
    projectRoot: '/private/project',
    baseEnv: {},
    fileSystem: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      openSync: () => 17,
      fstatSync: () => privateStat(),
      readFileSync: () => 'PRIVATE=value\n',
      lstatSync: () => privateStat(),
      closeSync: () => { throw new Error('private close failure'); },
    },
  }), (error) => error.message === 'Environment file could not be read securely.'
    && !error.message.includes('private close failure')
    && !error.message.includes('/private/project'));
});

test('loadConfig applies safe defaults relative to the project root', () => {
  const config = loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: validPortalUrl,
      PORTAL_CALL_SECRET: validCallSecret,
    },
    projectRoot: '/tmp/reporter',
  });

  assert.equal(config.portalWebhookUrl, validPortalUrl);
  assert.equal(config.portalCallSecret, validCallSecret);
  assert.equal(config.browserProfilePath, path.resolve('/tmp/reporter', '.linkedin-browser-profile'));
  assert.equal(config.outboxPath, path.resolve('/tmp/reporter', '.linkedin-unread-outbox.json'));
  assert.equal(config.outboxLockPath, path.resolve('/tmp/reporter', '.linkedin-unread-outbox.lock'));
  assert.equal(config.timestampWorkPath, path.resolve('/tmp/reporter', '.linkedin-timestamp-work.json'));
  assert.equal(config.timestampResultPath, path.resolve('/tmp/reporter', '.linkedin-timestamp-results.json'));
  assert.equal(config.unreadUrl, 'https://www.linkedin.com/messaging/?filter=unread');
  assert.equal(config.maxUnreadConversations, 50);
  assert.equal(config.authTimeoutMs, 900_000);
  assert.equal(config.reportTimezone, 'Australia/Adelaide');
});

test('loadConfig allows scan-only operation without portal credentials', () => {
  const config = loadConfig({ env: {}, projectRoot: '/tmp/reporter', requirePortal: false });
  assert.equal(config.portalWebhookUrl, null);
  assert.equal(config.portalCallSecret, null);
});

test('loadConfig rejects missing portal credentials for delivery', () => {
  assert.throws(
    () => loadConfig({ env: {}, projectRoot: '/tmp/reporter' }),
    (error) => error instanceof ConfigError && /npm run configure/.test(error.message),
  );
});

test('loadConfig rejects invalid values without echoing them', () => {
  const secret = 'https://user:private-secret@portal.example.test/hooks/linkedin';
  assert.throws(
    () => loadConfig({
      env: { PORTAL_WEBHOOK_URL: secret, PORTAL_CALL_SECRET: validCallSecret },
      projectRoot: '/tmp/reporter',
    }),
    (error) => error instanceof ConfigError && !error.message.includes(secret),
  );
  assert.throws(
    () => loadConfig({
      env: {
        PORTAL_WEBHOOK_URL: validPortalUrl,
        PORTAL_CALL_SECRET: validCallSecret,
        MAX_UNREAD_CONVERSATIONS: '0',
      },
      projectRoot: '/tmp/reporter',
    }),
    /MAX_UNREAD_CONVERSATIONS/,
  );
});

test('loadConfig validates the IANA timezone', () => {
  assert.throws(
    () => loadConfig({
      env: {
        PORTAL_WEBHOOK_URL: validPortalUrl,
        PORTAL_CALL_SECRET: validCallSecret,
        REPORT_TIMEZONE: 'Mars/Olympus',
      },
      projectRoot: '/tmp/reporter',
    }),
    /REPORT_TIMEZONE/,
  );
});

test('parseEnvText handles comments, export syntax, quoting, and equals signs', () => {
  assert.deepEqual(parseEnvText([
    '# comment',
    'export FIRST=one',
    'SECOND="two words"',
    "THIRD='three=parts'",
    '',
  ].join('\n')), {
    FIRST: 'one',
    SECOND: 'two words',
    THIRD: 'three=parts',
  });
});

test('redactSecrets removes portal credentials supplied as secrets', () => {
  const message = `Request failed for ${validPortalUrl} with ${validCallSecret}`;
  const redacted = redactSecrets(message, { secrets: [validPortalUrl, validCallSecret] });
  assert.equal(redacted.includes(validPortalUrl), false);
  assert.equal(redacted.includes(validCallSecret), false);
});

test('redactSecrets deduplicates overlapping secrets and redacts longest first', () => {
  const callSecret = 'shared-secret';
  const portalUrl = `https://portal.example.test/hooks/${callSecret}`;
  assert.equal(
    redactSecrets(`${portalUrl} ${callSecret}`, {
      secrets: [callSecret, portalUrl, callSecret],
    }),
    '[REDACTED_PORTAL_SECRET] [REDACTED_PORTAL_SECRET]',
  );
});

test('loadConfig requires an HTTPS portal URL and call secret for delivery', () => {
  const config = loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: 'https://portal.example.test/hooks/linkedin',
      PORTAL_CALL_SECRET: 'private-call-secret',
    },
    projectRoot: '/tmp/reporter',
    requirePortal: true,
  });
  assert.equal(config.portalWebhookUrl, 'https://portal.example.test/hooks/linkedin');
  assert.equal(config.portalCallSecret, 'private-call-secret');
  assert.equal(config.outboxPath, '/tmp/reporter/.linkedin-unread-outbox.json');
  assert.equal(config.outboxLockPath, '/tmp/reporter/.linkedin-unread-outbox.lock');
});

test('loadConfig rejects HTTP portal URLs without echoing secrets', () => {
  assert.throws(() => loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: 'http://portal.example.test/hooks/linkedin',
      PORTAL_CALL_SECRET: 'do-not-print-this',
    },
    requirePortal: true,
  }), (error) => /HTTPS/.test(error.message) && !/do-not-print-this/.test(error.message));
});

test('loadConfig rejects raw portal URL characters unsafe for unquoted env values', () => {
  for (const portalWebhookUrl of [
    ' https://portal.example.test/hooks/linkedin',
    'https://portal.example.test/hooks/linkedin ',
    'https://portal.example.test/hooks/"linkedin',
    "https://portal.example.test/hooks/'linkedin",
    'https://portal.example.test/hooks/linkedin\nPORTAL_CALL_SECRET=injected',
    'https://portal.example.test/hooks/linkedin\rPORTAL_CALL_SECRET=injected',
    'https://portal.example.test/hooks/linked in',
    'https://portal.example.test/hooks/linked\tin',
    'https://portal.example.test/hooks/linked\vin',
    'https://portal.example.test/hooks/linked\fin',
    'https://portal.example.test/hooks/linked\u00a0in',
    'https://portal.example.test/hooks/linked\u2028in',
    'https://portal.example.test/hooks/linked\u2029in',
  ]) {
    assert.throws(() => loadConfig({
      env: { PORTAL_WEBHOOK_URL: portalWebhookUrl, PORTAL_CALL_SECRET: validCallSecret },
      requirePortal: true,
    }), (error) => error instanceof ConfigError && !error.message.includes(portalWebhookUrl));
  }
});

test('loadConfig rejects call secrets unsafe for unquoted env values', () => {
  for (const portalCallSecret of [
    ' leading',
    'trailing ',
    'embedded space',
    'embedded\ttab',
    'line\nbreak',
    'carriage\rreturn',
    'single\'quote',
    'double"quote',
    `control${String.fromCharCode(0x7f)}character`,
  ]) {
    assert.throws(() => loadConfig({
      env: { PORTAL_WEBHOOK_URL: validPortalUrl, PORTAL_CALL_SECRET: portalCallSecret },
      requirePortal: true,
    }), (error) => error instanceof ConfigError && !error.message.includes(portalCallSecret));
  }
});

test('loadConfig preserves printable non-space call secrets including equals signs', () => {
  const portalCallSecret = 'token=part==';
  const config = loadConfig({
    env: { PORTAL_WEBHOOK_URL: validPortalUrl, PORTAL_CALL_SECRET: portalCallSecret },
    requirePortal: true,
  });
  assert.equal(config.portalCallSecret, portalCallSecret);
});
