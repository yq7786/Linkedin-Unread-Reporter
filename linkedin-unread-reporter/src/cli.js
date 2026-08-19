#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { withPersistentBrowser } from './browser.js';
import { ConfigError, loadConfig, PROJECT_ROOT, readProjectEnv, redactSecrets } from './config.js';
import { configureSlack } from './configure.js';
import { formatSlackReport } from './report.js';
import { scanUnreadConversations } from './scanner.js';
import { postSlackReport } from './slack.js';

const usage = 'Usage: node src/cli.js <configure|login|scan|slack-test|scheduled-report>';

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

export async function performBrowserScan(config, {
  onBlocker = () => {},
  chromiumImpl,
  withBrowserImpl = withPersistentBrowser,
  scanImpl = scanUnreadConversations,
} = {}) {
  const chromium = chromiumImpl || (await import('playwright')).chromium;
  return withBrowserImpl({
    chromium,
    profilePath: config.browserProfilePath,
    onBlocker,
    authTimeoutMs: config.authTimeoutMs,
    task: (adapter) => scanImpl({
      adapter,
      unreadUrl: config.unreadUrl,
      cap: config.maxUnreadConversations,
      authTimeoutMs: config.authTimeoutMs,
    }),
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
    configureSlackImpl: configureSlack,
    loginImpl: performBrowserLogin,
    scanImpl: performBrowserScan,
    postSlackImpl: postSlackReport,
    now: () => new Date(),
    ...overrides,
  };
}

export async function runCli(argv, overrides = {}) {
  const dependencies = defaultDependencies(overrides);
  const command = argv[0];

  try {
    if (command === 'configure') {
      if (!dependencies.isInteractive) {
        throw new Error('Configuration requires an interactive terminal. Run `npm run configure` manually.');
      }
      await dependencies.configureSlackImpl({
        envPath: path.join(dependencies.projectRoot, '.env'),
      });
      dependencies.stdout('Slack webhook saved securely to .env.');
      return 0;
    }

    if (!['login', 'scan', 'slack-test', 'scheduled-report'].includes(command)) {
      dependencies.stderr(usage);
      return 1;
    }

    const requireWebhook = !['login', 'scan'].includes(command);
    let env = dependencies.readEnvImpl({ projectRoot: dependencies.projectRoot });
    let config;
    try {
      config = dependencies.loadConfigImpl({
        env,
        projectRoot: dependencies.projectRoot,
        requireWebhook,
      });
    } catch (error) {
      const canConfigure = requireWebhook
        && dependencies.isInteractive
        && error instanceof ConfigError
        && error.message.includes('SLACK_WEBHOOK_URL');
      if (!canConfigure) throw error;
      await dependencies.configureSlackImpl({
        envPath: path.join(dependencies.projectRoot, '.env'),
      });
      dependencies.stdout('Slack webhook saved securely to .env.');
      env = dependencies.readEnvImpl({ projectRoot: dependencies.projectRoot });
      config = dependencies.loadConfigImpl({
        env,
        projectRoot: dependencies.projectRoot,
        requireWebhook: true,
      });
    }

    if (command === 'slack-test') {
      await dependencies.postSlackImpl({
        webhookUrl: config.slackWebhookUrl,
        text: 'LinkedIn unread reporter test: Slack delivery is configured.',
      });
      dependencies.stdout('Slack test message delivered.');
      return 0;
    }

    const blockerOptions = {
      onBlocker: ({ type }) => dependencies.stderr(
        `LinkedIn requires manual ${type}. Complete it in the visible browser within 15 minutes.`,
      ),
    };

    if (command === 'login') {
      await dependencies.loginImpl(config, blockerOptions);
      dependencies.stdout('LinkedIn session saved and login browser closed.');
      return 0;
    }

    const scanResult = await dependencies.scanImpl(config, blockerOptions);
    const count = scanResult.conversations.length;

    if (command === 'scan') {
      dependencies.stdout(`LinkedIn unread scan complete: ${count} conversation${count === 1 ? '' : 's'}.`);
      return 0;
    }

    const text = formatSlackReport({
      ...scanResult,
      scannedAt: dependencies.now(),
      timezone: config.reportTimezone,
      inboxUrl: config.unreadUrl,
    });
    await dependencies.postSlackImpl({ webhookUrl: config.slackWebhookUrl, text });
    dependencies.stdout(`Slack report delivered: ${count} conversation${count === 1 ? '' : 's'}.`);
    return 0;
  } catch (error) {
    dependencies.stderr(redactSecrets(error?.message || 'Unexpected failure.'));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
