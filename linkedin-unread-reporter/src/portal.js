import { randomUUID } from 'node:crypto';

import {
  ConfigError,
  validatePortalCallSecret,
  validatePortalUrl,
} from './config.js';
import { validateOutbox } from './outbox.js';

const MESSAGE_FIELDS = Object.freeze([
  'idempotencyKey',
  'linkedinMessageId',
  'leadName',
  'contentType',
  'content',
  'sentAt',
  'sentAtRaw',
  'sentAtAccuracy',
  'conversationUrl',
]);
const MESSAGE_FIELD_SET = new Set(MESSAGE_FIELDS);
const EMPTY_COUNTS = Object.freeze({ created: 0, duplicate: 0, assumedDuplicate: 0 });

export class PortalDeliveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortalDeliveryError';
  }
}

function invalidRequest() {
  throw new PortalDeliveryError('Portal request is invalid.');
}

function invalidDeliveryInput() {
  throw new PortalDeliveryError('Portal delivery input is invalid.');
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePortalCredentials({ webhookUrl, callSecret }) {
  let safeWebhookUrl;
  let safeCallSecret;
  try {
    safeWebhookUrl = validatePortalUrl(webhookUrl);
    safeCallSecret = validatePortalCallSecret(callSecret);
  } catch (error) {
    if (error instanceof ConfigError) invalidRequest();
    throw error;
  }
  if (!safeWebhookUrl || !safeCallSecret) invalidRequest();
  return { safeWebhookUrl, safeCallSecret };
}

function normalizeCapturedAt(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf()) && date.toISOString() === value) return value;
  }
  invalidRequest();
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) invalidRequest();
  const requestKeys = new Set();
  const normalized = messages.map((message, index) => {
    if (!isRecord(message)
      || Object.keys(message).length !== MESSAGE_FIELDS.length
      || !Object.keys(message).every((field) => MESSAGE_FIELD_SET.has(field))) invalidRequest();
    const copy = Object.fromEntries(MESSAGE_FIELDS.map((field) => [field, message[field]]));
    try {
      validateOutbox({
        version: 1,
        entries: [{ entryId: `portal-request-${index}`, state: 'ready', ...copy }],
      });
    } catch {
      invalidRequest();
    }
    if (requestKeys.has(copy.idempotencyKey)) invalidRequest();
    requestKeys.add(copy.idempotencyKey);
    return copy;
  });
  return { messages: normalized, requestKeys };
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) invalidRequest();
  return timeoutMs;
}

function statusCategory(status) {
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'unexpected-status';
}

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

async function readSanitizedAcknowledgements(response, requestKeys) {
  let body;
  try {
    if (typeof response.json !== 'function') return { results: null };
    body = await response.json();
  } catch {
    return { results: null };
  }
  if (!isRecord(body) || !Array.isArray(body.results)) return { results: null };
  return {
    results: body.results.map((result) => {
      if (!isRecord(result)
        || typeof result.idempotencyKey !== 'string'
        || !requestKeys.has(result.idempotencyKey)) return null;
      return {
        idempotencyKey: result.idempotencyKey,
        status: result.status === 'created' || result.status === 'duplicate'
          ? result.status
          : 'unknown',
      };
    }),
  };
}

export async function postPortalBatch({
  webhookUrl,
  callSecret,
  messages,
  capturedAt,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  const { safeWebhookUrl, safeCallSecret } = validatePortalCredentials({
    webhookUrl,
    callSecret,
  });
  const capturedAtIso = normalizeCapturedAt(capturedAt);
  const validatedTimeoutMs = validateTimeout(timeoutMs);
  if (typeof fetchImpl !== 'function') invalidRequest();
  const validated = validateMessages(messages);
  const controller = new AbortController();
  let timeout;
  const timeoutFailure = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new PortalDeliveryError('Portal delivery timed out.'));
    }, validatedTimeoutMs);
  });

  try {
    const delivery = (async () => {
      const response = await fetchImpl(safeWebhookUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'X-Portal-Call-Secret': safeCallSecret,
        },
        body: JSON.stringify({
          schemaVersion: '1',
          batchId: randomUUID(),
          capturedAt: capturedAtIso,
          messages: validated.messages,
        }),
        signal: controller.signal,
      });
      if (!response || !isSuccessStatus(response.status)) {
        throw new PortalDeliveryError(
          `Portal delivery failed (${statusCategory(response?.status)}).`,
        );
      }
      return readSanitizedAcknowledgements(response, validated.requestKeys);
    })();
    return await Promise.race([delivery, timeoutFailure]);
  } catch (error) {
    if (error instanceof PortalDeliveryError) throw error;
    if (controller.signal.aborted) {
      throw new PortalDeliveryError('Portal delivery timed out.');
    }
    throw new PortalDeliveryError('Portal delivery failed (network).');
  } finally {
    clearTimeout(timeout);
  }
}

function projectMessage(entry) {
  return Object.fromEntries(MESSAGE_FIELDS.map((field) => [field, entry[field]]));
}

function ensureUniqueRequestKeys(messages) {
  const keys = new Set();
  for (const message of messages) {
    if (keys.has(message.idempotencyKey)) invalidDeliveryInput();
    keys.add(message.idempotencyKey);
  }
}

function classifyAcknowledgements(acknowledgement, messages) {
  const counts = { ...EMPTY_COUNTS };
  let results;
  try {
    results = Array.isArray(acknowledgement?.results) ? acknowledgement.results : null;
  } catch {
    results = null;
  }
  if (!results) {
    counts.assumedDuplicate = messages.length;
    return counts;
  }

  for (const message of messages) {
    let matching;
    try {
      matching = results.filter((result) => isRecord(result)
        && result.idempotencyKey === message.idempotencyKey);
    } catch {
      counts.assumedDuplicate += 1;
      continue;
    }
    if (matching.length === 1 && matching[0].status === 'created') counts.created += 1;
    else if (matching.length === 1 && matching[0].status === 'duplicate') counts.duplicate += 1;
    else counts.assumedDuplicate += 1;
  }
  return counts;
}

export async function deliverReadyEntries({ outbox, postBatch, capturedAt }) {
  try {
    validateOutbox(outbox);
  } catch {
    invalidDeliveryInput();
  }
  const readyEntries = outbox.entries.filter((entry) => entry.state === 'ready');
  if (readyEntries.length === 0) {
    return { outbox, counts: { ...EMPTY_COUNTS } };
  }
  if (typeof postBatch !== 'function') invalidDeliveryInput();

  const messages = readyEntries.map(projectMessage);
  ensureUniqueRequestKeys(messages);
  const acknowledgement = await postBatch({ messages, capturedAt });
  const counts = classifyAcknowledgements(acknowledgement, messages);
  return {
    outbox: {
      version: outbox.version,
      entries: outbox.entries.filter((entry) => entry.state !== 'ready'),
    },
    counts,
  };
}
