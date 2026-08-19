import { createHash } from 'node:crypto';

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class MessageDataError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MessageDataError';
    this.code = code;
  }
}

function invalid(code) {
  throw new MessageDataError(code);
}

function hasValidCalendarDate(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysByMonth[month - 1];
}

export function normalizeLeadName(value) {
  if (typeof value !== 'string') invalid('lead-name-invalid');
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) invalid('lead-name-invalid');
  return normalized;
}

export function normalizeVisibleText(value) {
  if (typeof value !== 'string') invalid('visible-content-invalid');
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) invalid('visible-content-invalid');
  return normalized;
}

export function validateConversationUrl(value) {
  let url;
  try {
    url = new URL(String(value), 'https://www.linkedin.com');
  } catch {
    invalid('conversation-url-invalid');
  }
  if (url.protocol !== 'https:'
    || url.hostname !== 'www.linkedin.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || !/^\/messaging\/thread\/[^/]+\/$/.test(url.pathname)) {
    invalid('conversation-url-invalid');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function selectUnreadInboundMessages({ messages, unreadBoundaryIndex, expectedUnreadCount }) {
  if (!Array.isArray(messages)) invalid('messages-invalid');
  const inbound = messages.map((message, index) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      invalid('message-invalid');
    }
    if (!['inbound', 'outbound'].includes(message.direction)) {
      invalid('message-direction-invalid');
    }
    normalizeVisibleText(message.content);
    return { message, index };
  }).filter(({ message }) => message.direction === 'inbound');

  const hasUnreadBoundary = unreadBoundaryIndex !== null && unreadBoundaryIndex !== undefined;
  const hasExpectedUnreadCount = expectedUnreadCount !== null && expectedUnreadCount !== undefined;
  if (hasUnreadBoundary
    && (!Number.isInteger(unreadBoundaryIndex)
      || unreadBoundaryIndex < 0
      || unreadBoundaryIndex > messages.length)) {
    invalid('unread-boundary-invalid');
  }
  if (hasExpectedUnreadCount
    && (!Number.isInteger(expectedUnreadCount)
      || expectedUnreadCount <= 0
      || expectedUnreadCount > inbound.length)) {
    invalid('unread-count-invalid');
  }

  if (hasUnreadBoundary) {
    return inbound.filter(({ index }) => index >= unreadBoundaryIndex).map(({ message }) => message);
  }
  if (hasExpectedUnreadCount) {
    return inbound.slice(-expectedUnreadCount).map(({ message }) => message);
  }
  return inbound.length ? [inbound.at(-1).message] : [];
}

export function createIdempotencyKey({ linkedinMessageId, leadName, sentAt, conversationUrl }) {
  if (linkedinMessageId !== null && linkedinMessageId !== undefined) {
    if (typeof linkedinMessageId !== 'string' || !linkedinMessageId.trim()) {
      invalid('message-id-invalid');
    }
    return `linkedin:${linkedinMessageId.trim()}`;
  }

  const timestampMatch = typeof sentAt === 'string' ? ISO_TIMESTAMP.exec(sentAt) : null;
  if (!timestampMatch || !hasValidCalendarDate(timestampMatch)) {
    invalid('sent-at-invalid');
  }
  let canonicalTimestamp;
  try {
    canonicalTimestamp = new Date(sentAt).toISOString();
  } catch {
    invalid('sent-at-invalid');
  }

  const canonical = JSON.stringify([
    normalizeLeadName(leadName),
    canonicalTimestamp,
    validateConversationUrl(conversationUrl),
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
