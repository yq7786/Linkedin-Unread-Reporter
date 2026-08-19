#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LinkedInBlockerError, withPersistentBrowser } from './browser.js';
import { ConfigError, loadConfig, PROJECT_ROOT, readProjectEnv, redactSecrets } from './config.js';
import { configurePortal } from './configure.js';
import { ScanInvariantError } from './linkedin-state.js';
import { MessageDataError } from './messages.js';
import { loadOutbox, OutboxValidationError, saveOutbox, withOutboxLock } from './outbox.js';
import { PortalDeliveryError } from './portal.js';
import { captureUnreadMessages } from './scanner.js';
import { runPortalWorkflow } from './workflow.js';

const usage = 'Usage: node src/cli.js <configure|login|scan|deliver|scheduled-report>';
const COUNT_FIELDS = [
  'processedConversations',
  'capturedMessages',
  'created',
  'duplicate',
  'assumedDuplicate',
  'pendingRecovery',
  'pendingTimestamps',
];
const CAPTURE_COUNT_FIELDS = [
  'processedConversations', 'capturedMessages', 'pendingRecovery', 'pendingTimestamps',
];
const MESSAGE_ERROR_CODES = new Set([
  'conversation-url-invalid',
  'lead-name-invalid',
  'message-content-type-invalid',
  'message-direction-invalid',
  'message-duplicate',
  'message-id-invalid',
  'message-invalid',
  'messages-invalid',
  'sent-at-invalid',
  'unread-boundary-invalid',
  'unread-count-invalid',
  'unread-selection-empty',
  'visible-content-invalid',
]);
const SCAN_ERROR_CODES = new Set([
  'candidate-limit-invalid',
  'candidate-read-failed',
  'candidate-revalidation-failed',
  'conversation-detail-visible',
  'conversation-list-progress-invalid',
  'conversation-list-ambiguous',
  'conversation-list-missing',
  'conversation-list-not-uniquely-visible',
  'conversation-open-checkpoint-failed',
  'conversation-open-checkpoint-invalid',
  'conversation-open-failed',
  'conversation-open-row-mismatch',
  'conversation-row-active',
  'conversation-row-identity-ambiguous',
  'conversation-row-identity-missing',
  'conversation-row-metadata-ambiguous',
  'conversation-row-no-longer-eligible',
  'conversation-row-no-longer-unread',
  'conversation-row-not-uniquely-visible',
  'conversation-row-url-changed',
  'conversation-thread-not-uniquely-visible',
  'conversation-unread-count-invalid',
  'conversation-url-mismatch',
  'conversation-url-unavailable-for-recovery',
  'load-more-control-ambiguous',
  'load-more-control-inside-conversation-row',
  'load-more-control-not-safe',
  'message-content-ambiguous',
  'message-content-missing',
  'message-content-type-invalid',
  'message-direction-ambiguous',
  'message-list-missing',
  'message-time-ambiguous',
  'message-time-drift',
  'message-time-invalid',
  'message-time-tooltip-ambiguous',
  'thread-message-read-failed',
  'unread-boundary-ambiguous',
  'unread-filter-not-active',
  'unread-url-not-initialized',
]);
const BLOCKER_TYPES = new Set([
  'captcha', 'challenge', 'checkpoint', 'inbox readiness', 'login', 'navigation', 'thread navigation',
]);
const CONFIG_ERROR_MESSAGES = new Set([
  'Portal delivery is not configured. Run `npm run configure` in an interactive terminal.',
  'PORTAL_WEBHOOK_URL must be a valid HTTPS URL without embedded credentials. Run `npm run configure`.',
  'PORTAL_CALL_SECRET must contain only printable non-space characters and no quotes. Run `npm run configure`.',
  'LINKEDIN_UNREAD_URL must be LinkedIn messaging with filter=unread.',
  'REPORT_TIMEZONE must be a valid IANA timezone.',
  'MAX_UNREAD_CONVERSATIONS must be an integer between 1 and 50.',
  'LINKEDIN_AUTH_TIMEOUT_MS must be an integer between 1000 and 900000.',
]);
const STATIC_INTERNAL_MESSAGES = new Set([
  'Configuration requires an interactive terminal. Run `npm run configure` manually.',
  'Environment file could not be read securely.',
  'LinkedIn unread reporter is already running.',
  'Outbox lock failed.',
  'Outbox JSON is corrupt.',
  'Private state could not be read securely.',
  'Timestamp result close failed.',
  'Timestamp result read failed.',
  'Timestamp result permissions are invalid.',
  'Timestamp result polling timed out.',
  'Timestamp data is invalid.',
  'Timestamp scan anchor is invalid.',
  'Timestamp attempt is invalid.',
  'Workflow dependency output is invalid.',
  'Workflow capture dependency is invalid.',
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function count(value, field) {
  if (!Object.hasOwn(value, field)) throw new Error('Command result counts are invalid.');
  const result = value[field];
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Command result counts are invalid.');
  }
  return result;
}

function projectCounts(value, fields) {
  if (!isRecord(value)) throw new Error('Command result counts are invalid.');
  return Object.fromEntries(fields.map((field) => [field, count(value, field)]));
}

const countOnlyResult = (value) => projectCounts(value, COUNT_FIELDS);
const captureCountOnlyResult = (value) => projectCounts(value, CAPTURE_COUNT_FIELDS);

function formatWorkflowCounts(value) {
  const result = countOnlyResult(value);
  return [
    `Processed: ${result.processedConversations} conversations`,
    `Captured: ${result.capturedMessages} messages`,
    `Created: ${result.created}`,
    `Duplicates: ${result.duplicate}`,
    `Assumed duplicates: ${result.assumedDuplicate}`,
    `Pending recovery: ${result.pendingRecovery}`,
    `Pending timestamps: ${result.pendingTimestamps}`,
  ].join('; ');
}

function exactErrorClass(error, ErrorClass) {
  return error?.constructor === ErrorClass;
}

function exactStaticMessage(error, messages) {
  for (const message of messages) if (error.message === message) return message;
  return null;
}

function knownErrorMessage(error) {
  if (exactErrorClass(error, ConfigError)) {
    return exactStaticMessage(error, CONFIG_ERROR_MESSAGES) || 'Unexpected failure.';
  }
  if (exactErrorClass(error, LinkedInBlockerError) && BLOCKER_TYPES.has(error.type)) {
    return `LinkedIn ${error.type} was not cleared within the allowed time. No report was sent.`;
  }
  if (exactErrorClass(error, ScanInvariantError) && SCAN_ERROR_CODES.has(error.code)) {
    return `LinkedIn unread-list safety invariant failed: ${error.code}. No report was sent.`;
  }
  if (exactErrorClass(error, MessageDataError) && MESSAGE_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  if (exactErrorClass(error, OutboxValidationError)) return 'Outbox data is invalid.';
  if (exactErrorClass(error, PortalDeliveryError)) {
    const staticMessage = exactStaticMessage(error, [
      'Portal request is invalid.',
      'Portal delivery input is invalid.',
      'Portal delivery timed out.',
      'Portal delivery failed (network).',
      'Portal delivery failed (1xx).',
      'Portal delivery failed (3xx).',
      'Portal delivery failed (4xx).',
      'Portal delivery failed (5xx).',
      'Portal delivery failed (unknown).',
    ]);
    return staticMessage || 'Unexpected failure.';
  }
  if (exactErrorClass(error, Error)) {
    const staticMessage = exactStaticMessage(error, STATIC_INTERNAL_MESSAGES);
    if (staticMessage) return staticMessage;
    const pendingMatch = /^(\d+) timestamp item\(s\) remain pending\.$/.exec(error.message);
    if (pendingMatch && Number.isSafeInteger(Number(pendingMatch[1]))) {
      return `${Number(pendingMatch[1])} timestamp item(s) remain pending.`;
    }
  }
  return 'Unexpected failure.';
}

function redactCliError(error, secrets) {
  return redactSecrets(knownErrorMessage(error), { secrets })
    .replace(/https:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/[^\s'"<>]*/gi, '[REDACTED_LINKEDIN_URL]')
    .replace(/\b(?:linkedinMessageId|conversationUrl|leadName|content)\s*[:=]\s*[^\s,;]+/gi, (value) => {
      const separator = value.includes('=') ? '=' : ':';
      return `${value.slice(0, value.indexOf(separator) + 1)}[REDACTED_LINKEDIN_IDENTIFIER]`;
    });
}

function checkpoint(signal) {
  signal.throwIfAborted();
}

async function checkedAwait(signal, operation) {
  checkpoint(signal);
  try {
    return await operation();
  } finally {
    checkpoint(signal);
  }
}

function checkedCall(signal, operation) {
  checkpoint(signal);
  try {
    return operation();
  } finally {
    checkpoint(signal);
  }
}

function exactPlainObject(value, fields) {
  return isRecord(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function blockerMessage(payload) {
  const allowedTypes = new Set(['login', 'checkpoint', 'captcha', 'challenge']);
  if (!exactPlainObject(payload, ['type']) || !allowedTypes.has(payload.type)) {
    throw new Error('Blocker notification is invalid.');
  }
  return `LinkedIn requires manual ${payload.type}. Complete it in the visible browser within 15 minutes.`;
}

function timestampWorkMessage(payload) {
  if (!exactPlainObject(payload, ['count', 'attempt'])
    || !Number.isSafeInteger(payload.count)
    || payload.count < 0
    || !Number.isInteger(payload.attempt)
    || payload.attempt < 1
    || payload.attempt > 3) {
    throw new Error('Timestamp notification is invalid.');
  }
  return `Timestamp normalization required: ${payload.count} item(s), attempt ${payload.attempt} of 3.`;
}

export async function performBrowserLogin(config, {
  onBlocker = () => {},
  chromiumImpl,
  withBrowserImpl = withPersistentBrowser,
} = {}) {
  const chromium = chromiumImpl || (await import('playwright')).chromium;
  return withBrowserImpl({
    chromium,
    profilePath: config.browserProfilePath,
    onBlocker,
    authTimeoutMs: config.authTimeoutMs,
    task: async (adapter) => {
      await adapter.gotoUnread(config.unreadUrl);
      return adapter.waitForUnblocked(config.authTimeoutMs);
    },
  });
}

export async function performBrowserCapture(config, captureOptions, {
  onBlocker = () => {},
  chromiumImpl,
  withBrowserImpl = withPersistentBrowser,
  captureImpl = captureUnreadMessages,
} = {}) {
  const chromium = chromiumImpl || (await import('playwright')).chromium;
  return withBrowserImpl({
    chromium,
    profilePath: config.browserProfilePath,
    onBlocker,
    authTimeoutMs: config.authTimeoutMs,
    signal: captureOptions.signal,
    task: (adapter) => captureImpl({ ...captureOptions, adapter }),
  });
}

export async function runCaptureDryRun({
  config,
  capture,
  withLock = withOutboxLock,
  load = loadOutbox,
  save = saveOutbox,
  now = () => new Date(),
}) {
  if (typeof capture !== 'function') throw new Error('Capture dependency is invalid.');
  return withLock({
    lockPath: config.outboxLockPath,
    task: async ({ signal }) => {
      const outbox = await checkedAwait(signal, () => load({ outboxPath: config.outboxPath }));
      const scanStartedAt = checkedCall(signal, now);
      const result = await checkedAwait(signal, () => capture({
        outbox,
        saveOutbox: (value) => checkedAwait(
          signal,
          () => save({ outboxPath: config.outboxPath, value }),
        ),
        unreadUrl: config.unreadUrl,
        scanStartedAt,
        cap: config.maxUnreadConversations,
        authTimeoutMs: config.authTimeoutMs,
        recoverPending: true,
        captureNew: true,
        signal,
      }));
      return captureCountOnlyResult(result);
    },
  });
}

function defaultDependencies(overrides) {
  return {
    projectRoot: PROJECT_ROOT,
    isInteractive: Boolean(process.stdin.isTTY),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    loadConfigImpl: loadConfig,
    readEnvImpl: readProjectEnv,
    configurePortalImpl: configurePortal,
    loginImpl: performBrowserLogin,
    captureImpl: performBrowserCapture,
    captureDryRunImpl: runCaptureDryRun,
    workflowImpl: runPortalWorkflow,
    ...overrides,
  };
}

export async function runCli(argv, overrides = {}) {
  const dependencies = defaultDependencies(overrides);
  const command = argv[0];
  let config;
  let env;

  try {
    if (!['configure', 'login', 'scan', 'deliver', 'scheduled-report'].includes(command)) {
      dependencies.stderr(usage);
      return 1;
    }

    if (command === 'configure') {
      if (!dependencies.isInteractive) {
        throw new Error('Configuration requires an interactive terminal. Run `npm run configure` manually.');
      }
      await dependencies.configurePortalImpl({
        envPath: path.join(dependencies.projectRoot, '.env'),
      });
      dependencies.stdout('Portal configuration saved securely to .env.');
      return 0;
    }

    env = dependencies.readEnvImpl({ projectRoot: dependencies.projectRoot });
    config = dependencies.loadConfigImpl({
      env,
      projectRoot: dependencies.projectRoot,
      requirePortal: !['login', 'scan'].includes(command),
    });

    const blockerOptions = {
      onBlocker: (payload) => dependencies.stderr(blockerMessage(payload)),
    };

    if (command === 'login') {
      await dependencies.loginImpl(config, blockerOptions);
      dependencies.stdout('LinkedIn session saved and login browser closed.');
      return 0;
    }

    const capture = (options) => dependencies.captureImpl(config, options, blockerOptions);
    if (command === 'scan') {
      const result = await dependencies.captureDryRunImpl({ config, capture });
      const counts = captureCountOnlyResult(result);
      dependencies.stdout(
        `Captured: ${counts.capturedMessages} messages from ${counts.processedConversations} conversations; `
        + `Pending recovery: ${counts.pendingRecovery}; Pending timestamps: ${counts.pendingTimestamps}.`,
      );
      return 0;
    }

    const result = await dependencies.workflowImpl({
      config,
      capture,
      captureNew: command === 'scheduled-report',
      notifyTimestampWork: (payload) => dependencies.stdout(timestampWorkMessage(payload)),
    });
    dependencies.stdout(formatWorkflowCounts(result));
    return 0;
  } catch (error) {
    const secrets = [
      config?.portalWebhookUrl,
      config?.portalCallSecret,
      env?.PORTAL_WEBHOOK_URL,
      env?.PORTAL_CALL_SECRET,
    ];
    dependencies.stderr(redactCliError(error, secrets));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
