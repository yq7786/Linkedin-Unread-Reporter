import fs from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, PROJECT_ROOT } from './config.js';
import { readPrivateFile } from './private-file.js';

export function updateEnvText(existingText, values) {
  const pending = new Map(Object.entries(values));
  const output = [];

  for (const line of existingText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !pending.has(match[1])) {
      output.push(line);
      continue;
    }
    if (pending.get(match[1]) !== null) {
      output.push(`${match[1]}=${pending.get(match[1])}`);
      pending.set(match[1], null);
    }
  }

  while (output.length && output.at(-1) === '') output.pop();
  for (const [key, value] of pending) {
    if (value !== null) output.push(`${key}=${value}`);
  }
  return `${output.join('\n')}\n`;
}

export async function readHiddenSecret({
  prompt = 'Secret: ',
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('A terminal is required. Run `npm run configure` interactively.');
  }

  stdout.write(prompt);
  stdin.setEncoding('utf8');
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Configuration cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function writePrivateEnv({ envPath, values, fileSystem, processId }) {
  const existingText = await readPrivateFile({
    filePath: envPath,
    fileSystem,
    errorMessage: 'Environment file could not be read securely.',
  }) ?? '';

  const updatedText = updateEnvText(existingText, values);
  const temporaryPath = `${envPath}.tmp-${processId}`;
  try {
    await fileSystem.writeFile(temporaryPath, updatedText, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fileSystem.chmod(temporaryPath, 0o600);
    await fileSystem.rename(temporaryPath, envPath);
  } finally {
    await fileSystem.rm(temporaryPath, { force: true });
  }
}

export async function configurePortal({
  envPath = path.join(PROJECT_ROOT, '.env'),
  askSecret = (prompt) => readHiddenSecret({ prompt }),
  fileSystem = fs,
  processId = process.pid,
} = {}) {
  const portalWebhookUrl = await askSecret('Portal Webhook URL (input hidden): ');
  const portalCallSecret = await askSecret('PORTAL_CALL_SECRET (input hidden): ');
  loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: portalWebhookUrl,
      PORTAL_CALL_SECRET: portalCallSecret,
    },
    projectRoot: path.dirname(envPath),
    requirePortal: true,
  });

  await writePrivateEnv({
    envPath,
    values: {
      PORTAL_WEBHOOK_URL: portalWebhookUrl,
      PORTAL_CALL_SECRET: portalCallSecret,
    },
    fileSystem,
    processId,
  });

  return { configured: true, envPath };
}
