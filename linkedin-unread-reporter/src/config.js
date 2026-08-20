import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPrivateFileSync } from './private-file.js';

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

export function readProjectEnv({
  projectRoot = PROJECT_ROOT,
  baseEnv = process.env,
  fileSystem = fs,
} = {}) {
  const envPath = path.join(projectRoot, '.env');
  let fileValues = {};
  const text = readPrivateFileSync({
    filePath: envPath,
    fileSystem,
    errorMessage: 'Environment file could not be read securely.',
  });
  if (text !== null) fileValues = parseEnvText(text);
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

function unwrapPastedHttpsUrl(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const angled = /^<([^>]+)>$/.exec(trimmed);
  if (angled) return angled[1].trim();
  const markdown = /^\[(?:[^\]]*)\]\((https:[^)\s]+)\)$/i.exec(trimmed);
  if (markdown) return markdown[1].trim();
  return value;
}

export function validatePortalUrl(value) {
  if (!value) return null;
  try {
    const unwrapped = unwrapPastedHttpsUrl(value);
    if (typeof unwrapped !== 'string'
      || /[\p{C}\p{Z}\s'"]/u.test(unwrapped)) {
      throw new Error('invalid');
    }
    const url = new URL(unwrapped);
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

export function validatePortalCallSecret(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || /[\p{C}\p{Z}\s'"]/u.test(value)) {
    throw new ConfigError('PORTAL_CALL_SECRET must contain only printable non-space characters and no quotes. Run `npm run configure`.');
  }
  return value;
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
  requirePortal = true,
} = {}) {
  const portalWebhookUrl = validatePortalUrl(env.PORTAL_WEBHOOK_URL);
  const portalCallSecret = validatePortalCallSecret(env.PORTAL_CALL_SECRET);
  if (requirePortal && (!portalWebhookUrl || !portalCallSecret)) {
    throw new ConfigError('Portal delivery is not configured. Run `npm run configure` in an interactive terminal.');
  }

  const profileSetting = env.LINKEDIN_BROWSER_PROFILE_PATH || DEFAULTS.browserProfilePath;
  const browserProfilePath = path.isAbsolute(profileSetting)
    ? profileSetting
    : path.resolve(projectRoot, profileSetting);

  return Object.freeze({
    projectRoot,
    portalWebhookUrl,
    portalCallSecret,
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
  let redacted = String(value);
  const explicitSecrets = [...new Set(
    secrets.filter((secret) => typeof secret === 'string' && secret),
  )].sort((left, right) => right.length - left.length);
  for (const secret of explicitSecrets) {
    redacted = redacted.split(secret).join('[REDACTED_PORTAL_SECRET]');
  }
  return redacted;
}
