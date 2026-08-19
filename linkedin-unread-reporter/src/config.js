import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = Object.freeze({
  browserProfilePath: '.linkedin-browser-profile',
  outboxPath: '.linkedin-unread-outbox.json',
  outboxLockPath: '.linkedin-unread-outbox.lock',
  timestampWorkPath: '.linkedin-timestamp-work.json',
  timestampResultPath: '.linkedin-timestamp-results.json',
  unreadUrl: 'https://www.linkedin.com/messaging/?filter=unread',
  maxUnreadConversations: 50,
  authTimeoutMs: 900_000,
  reportTimezone: 'Australia/Adelaide',
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function readProjectEnv({ projectRoot = PROJECT_ROOT, baseEnv = process.env } = {}) {
  const envPath = path.join(projectRoot, '.env');
  let fileValues = {};
  try {
    fileValues = parseEnvText(fs.readFileSync(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...fileValues, ...baseEnv };
}

function parseBoundedInteger(value, fallback, name, { min, max }) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function validatePortalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:'
      || url.username
      || url.password) {
      throw new Error('invalid');
    }
    return url.toString();
  } catch {
    throw new ConfigError('PORTAL_WEBHOOK_URL must be a valid HTTPS URL without embedded credentials. Run `npm run configure`.');
  }
}

function validatePortalCallSecret(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

function validateSlackWebhook(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:'
      || url.hostname !== 'hooks.slack.com'
      || !/^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
      || url.search
      || url.hash) {
      throw new Error('invalid');
    }
    return url.toString();
  } catch {
    throw new ConfigError('SLACK_WEBHOOK_URL must be a valid Slack incoming-webhook URL. Run `npm run configure`.');
  }
}

function validateUnreadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:'
      || url.hostname !== 'www.linkedin.com'
      || url.pathname !== '/messaging/'
      || url.searchParams.get('filter') !== 'unread') {
      throw new Error('invalid');
    }
    return url.toString();
  } catch {
    throw new ConfigError('LINKEDIN_UNREAD_URL must be LinkedIn messaging with filter=unread.');
  }
}

function validateTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: value }).format();
    return value;
  } catch {
    throw new ConfigError('REPORT_TIMEZONE must be a valid IANA timezone.');
  }
}

export function loadConfig({
  env = readProjectEnv(),
  projectRoot = PROJECT_ROOT,
  requirePortal,
  requireWebhook,
} = {}) {
  const portalWebhookUrl = validatePortalUrl(env.PORTAL_WEBHOOK_URL);
  const portalCallSecret = validatePortalCallSecret(env.PORTAL_CALL_SECRET);
  const slackWebhookUrl = requireWebhook === undefined
    ? null
    : validateSlackWebhook(env.SLACK_WEBHOOK_URL);
  const portalRequired = requirePortal ?? (requireWebhook === undefined);
  if (portalRequired && (!portalWebhookUrl || !portalCallSecret)) {
    throw new ConfigError('Portal delivery is not configured. Run `npm run configure` in an interactive terminal.');
  }
  if (requireWebhook && !slackWebhookUrl) {
    throw new ConfigError('SLACK_WEBHOOK_URL is not configured. Run `npm run configure` in an interactive terminal.');
  }

  const profileSetting = env.LINKEDIN_BROWSER_PROFILE_PATH || DEFAULTS.browserProfilePath;
  const browserProfilePath = path.isAbsolute(profileSetting)
    ? profileSetting
    : path.resolve(projectRoot, profileSetting);

  return Object.freeze({
    projectRoot,
    portalWebhookUrl,
    portalCallSecret,
    slackWebhookUrl,
    browserProfilePath,
    outboxPath: path.resolve(projectRoot, DEFAULTS.outboxPath),
    outboxLockPath: path.resolve(projectRoot, DEFAULTS.outboxLockPath),
    timestampWorkPath: path.resolve(projectRoot, DEFAULTS.timestampWorkPath),
    timestampResultPath: path.resolve(projectRoot, DEFAULTS.timestampResultPath),
    unreadUrl: validateUnreadUrl(env.LINKEDIN_UNREAD_URL || DEFAULTS.unreadUrl),
    maxUnreadConversations: parseBoundedInteger(
      env.MAX_UNREAD_CONVERSATIONS,
      DEFAULTS.maxUnreadConversations,
      'MAX_UNREAD_CONVERSATIONS',
      { min: 1, max: 50 },
    ),
    authTimeoutMs: parseBoundedInteger(
      env.LINKEDIN_AUTH_TIMEOUT_MS,
      DEFAULTS.authTimeoutMs,
      'LINKEDIN_AUTH_TIMEOUT_MS',
      { min: 1_000, max: 900_000 },
    ),
    reportTimezone: validateTimezone(env.REPORT_TIMEZONE || DEFAULTS.reportTimezone),
  });
}

export function redactSecrets(value, { secrets = [] } = {}) {
  let redacted = String(value).replace(
    /https:\/\/hooks\.slack\.com\/services\/[^\s'"<>]+/gi,
    '[REDACTED_SLACK_WEBHOOK]',
  );
  const explicitSecrets = [...new Set(
    secrets.filter((secret) => typeof secret === 'string' && secret),
  )].sort((left, right) => right.length - left.length);
  for (const secret of explicitSecrets) {
    redacted = redacted.split(secret).join('[REDACTED_PORTAL_SECRET]');
  }
  return redacted;
}
