import { redactSecrets } from './config.js';

export class SlackDeliveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlackDeliveryError';
  }
}

function statusCategory(status) {
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'unexpected-status';
}

export async function postSlackReport({
  webhookUrl,
  text,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new SlackDeliveryError(`Slack rejected the report (${statusCategory(response.status)}).`);
    }
    return { delivered: true, status: response.status };
  } catch (error) {
    if (error instanceof SlackDeliveryError) throw error;
    throw new SlackDeliveryError(`Slack delivery failed: ${redactSecrets(error?.message || 'network error')}`);
  }
}
