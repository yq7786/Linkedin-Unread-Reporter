import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { PROJECT_ROOT } from '../src/config.js';

const skillRoot = PROJECT_ROOT;
const execFileAsync = promisify(execFile);

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

function extractFencedPrompt(markdown, sectionHeading) {
  const heading = `## ${sectionHeading}`;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const nextHeading = markdown.indexOf('\n## ', start + heading.length);
  const section = markdown.slice(start, nextHeading === -1 ? undefined : nextHeading);
  const match = /```text\n([\s\S]*?)\n```/.exec(section);
  assert.ok(match, `missing text prompt in ${heading}`);
  return match[1];
}

function extractSection(markdown, sectionHeading) {
  const heading = `## ${sectionHeading}`;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const nextHeading = markdown.indexOf('\n## ', start + heading.length);
  return markdown.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

function assertNoCredentialValuesOrAbsolutePaths(prompt) {
  assert.doesNotMatch(prompt, /\/(?:Users|home|tmp|opt|var)\//i);
  assert.doesNotMatch(prompt, /(?:^|[\s("'`=])\/(?!\/)[A-Za-z0-9._~-]+(?:\/[^\s"'`)]+)?/m);
  assert.doesNotMatch(prompt, /\b[A-Za-z]:[\\/]/);
  assert.doesNotMatch(prompt, /PORTAL_WEBHOOK_URL\s*=|PORTAL_CALL_SECRET\s*=/);
  assert.doesNotMatch(prompt, /https?:\/\//i);
  assert.doesNotMatch(prompt, /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/i);
  assert.doesNotMatch(prompt, /\b(?:secret|token|webhook)\s*[:=]\s*["']?[^\s"'`]+/i);
}

test('repository root is the complete standalone skill', async () => {
  assert.equal(await exists(path.join(skillRoot, 'SKILL.md')), true);
  assert.equal(await exists(path.join(skillRoot, 'agents', 'openai.yaml')), true);
  assert.equal(await exists(path.join(skillRoot, 'references', 'automation-setup.md')), true);
  assert.equal(await exists(path.join(skillRoot, 'package.json')), true);
  assert.equal(await exists(path.join(skillRoot, 'src', 'cli.js')), true);
});

test('plugin and marketplace wrappers are absent', async () => {
  assert.equal(await exists(path.join(PROJECT_ROOT, '.agents', 'plugins', 'marketplace.json')), false);
  assert.equal(await exists(path.join(PROJECT_ROOT, 'plugins', 'linkedin-unread-reporter')), false);
});

test('skill metadata and instructions are complete and portable', async () => {
  const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const metadata = await fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  const automation = await fs.readFile(path.join(skillRoot, 'references', 'automation-setup.md'), 'utf8');
  const readme = await fs.readFile(path.join(skillRoot, '..', 'README.md'), 'utf8');

  assert.match(skill, /^---\nname: linkedin-unread-reporter\ndescription: .+\n---/);
  assert.match(skill, /npm run configure/);
  assert.match(skill, /npm run login/);
  assert.ok(skill.indexOf('npm run login') < skill.indexOf('npm run scan'));
  assert.match(skill, /Verify Node\.js 18 or newer/);
  assert.doesNotMatch(skill, /User Agreement/);
  assert.doesNotMatch(skill, /Run `npm test`/);
  assert.match(metadata, /\$linkedin-unread-reporter/);

  for (const document of [skill, readme]) {
    assert.match(document, /PORTAL_WEBHOOK_URL/);
    assert.match(document, /PORTAL_CALL_SECRET/);
    assert.match(document, /HTTPS/);
    assert.match(document, /0600/);
  }
  assert.match(metadata, /private portal/i);

  assert.match(skill, /read-on-open/i);
  assert.match(skill, /\.linkedin-unread-outbox\.json/);
  assert.match(skill, /checkpoint immediately after extraction/i);
  assert.match(skill, /explicitly eligible unread one-to-one thread/i);
  assert.match(skill, /never send or edit a LinkedIn message/i);
  assert.match(skill, /never follow or download an attachment/i);
  assert.ok(skill.indexOf('npm run scan') < skill.indexOf('npm run deliver'));
  assert.match(skill, /approval[^\n]+npm run deliver/i);
  assert.match(skill, /direct-URL candidate[^\n]+marker[^\n]+before opening/i);
  assert.match(skill, /hidden[^\n]+stable destination[^\n]+direct-URL[^\n]+before opening/i);
  assert.match(skill, /anchorless[^\n]+exact row[^\n]+active row[^\n]+onOpened[^\n]+before extraction/i);
  assert.match(skill, /responsive markup[^\n]+fails closed with no marker/i);
  assert.match(skill, /truly anchorless[^\n]+unavoidable crash window/i);
  assert.match(skill, /narrow unavoidable crash window/i);
  assert.doesNotMatch(skill, /reporter checkpoints before opening/i);
  assert.doesNotMatch(skill, /Before opening anything[^\n]+stable one-to-one conversation URL/i);

  for (const document of [skill, automation, readme]) {
    assert.match(document, /Created \+ Duplicates \+ Assumed duplicates > 0/);
    assert.match(document, /dry scan[^\n]+zero[^\n]+defer[^\n]+schedules/i);
    assert.match(document, /no HTTP acknowledgement[^\n]+defer[^\n]+schedules/i);
  }

  assert.match(automation, /Australia\/Adelaide/);
  assert.match(automation, /7:00am/);
  assert.match(automation, /12:00pm/);
  assert.match(automation, /4:00pm/);
  assert.match(automation, /model:\s*`gpt-5\.6-sol`/);
  assert.match(automation, /reasoning effort:\s*`medium`/);
  assert.doesNotMatch(automation, /gpt-5\.4/i);
  assert.doesNotMatch(automation, /Ask for the user's desired weekdays/);
  assert.doesNotMatch(automation, /\/Users\/[A-Za-z0-9._-]+\//);

  const scheduledPrompt = extractFencedPrompt(automation, 'Automation rules');
  assert.match(scheduledPrompt, /allocate and use a persistent PTY/i);
  assert.match(scheduledPrompt, /npm run report/);
  assert.match(scheduledPrompt, /Timestamp normalization required: N item\(s\), attempt X of 3\./);
  assert.match(scheduledPrompt, /monitor[^\n]+same PTY process\/session/i);
  assert.match(scheduledPrompt, /exactly one timestamp-only subagent[^\n]+each emitted marker[^\n]+attempt/i);
  assert.match(scheduledPrompt, /attempt 1 of 3/i);
  assert.match(scheduledPrompt, /attempt 2 of 3/i);
  assert.match(scheduledPrompt, /attempt 3 of 3/i);
  assert.match(scheduledPrompt, /local fallback after attempt three/i);
  assert.match(scheduledPrompt, /never pass names, message content, or LinkedIn URLs/i);
  assert.match(scheduledPrompt, /never pass timestamps, credentials/i);
  assert.match(scheduledPrompt, /count-only/i);
  assertNoCredentialValuesOrAbsolutePaths(scheduledPrompt);

  const timestampPrompt = extractFencedPrompt(automation, 'Timestamp-only subagent protocol');
  assert.match(timestampPrompt, /\.linkedin-timestamp-work\.json/);
  assert.match(timestampPrompt, /\.linkedin-timestamp-results\.json/);
  assert.match(timestampPrompt, /relativeTime/);
  assert.match(timestampPrompt, /scanStartedAt/);
  assert.match(timestampPrompt, /copy the top-level input workId\s+verbatim/i);
  assert.match(timestampPrompt, /never invent[^\n]+workId/i);
  assert.match(timestampPrompt, /"workId":"<WORK-ID>"/);
  assert.match(timestampPrompt, /copy each input itemKey verbatim/i);
  assert.match(timestampPrompt, /never invent[^\n]+itemKey/i);
  assert.match(timestampPrompt, /"itemKey":"timestamp-N"/);
  assert.match(timestampPrompt, /"sentAt":"<ISO-8601>"/);
  assert.match(timestampPrompt, /atomically write mode-`0600`/i);
  assert.match(timestampPrompt, /Do not read the\s+outbox, browser profile, \.env, lead names, message content, or LinkedIn URLs/);
  assert.match(timestampPrompt, /only the number of converted items/i);
  assert.doesNotMatch(timestampPrompt, /entry-1|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/);
  assert.doesNotMatch(timestampPrompt, /Ada|Hello|linkedin\.com\/messaging/i);
  assertNoCredentialValuesOrAbsolutePaths(timestampPrompt);

  const installSummary = extractSection(readme, 'Install as a standalone Codex skill');
  assert.match(installSummary, /capturedMessages > 0/);
  assert.match(installSummary, /Created \+ Duplicates \+ Assumed duplicates > 0/);
  assert.match(installSummary, /otherwise[^\n]+defer[^\n]+schedules/i);

  const scheduleSummary = extractSection(readme, 'Default schedule');
  assert.match(scheduleSummary, /capturedMessages > 0/);
  assert.match(scheduleSummary, /Created \+ Duplicates \+ Assumed duplicates > 0/);
  assert.match(scheduleSummary, /otherwise[^\n]+defer/i);
});

test('package and lockfile require Node 18 with a compatible Playwright pin', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8'));

  assert.equal(manifest.engines.node, '>=18');
  assert.equal(manifest.scripts.test, 'node test/run-tests.js');
  assert.equal(manifest.scripts.login, 'node src/cli.js login');
  assert.equal(manifest.scripts.report, 'node src/cli.js scheduled-report');
  assert.equal(
    manifest.scripts.check,
    'node --check src/*.js && node test/run-tests.js',
  );
  assert.equal(manifest.dependencies.playwright, '1.55.1');
  assert.equal(manifest.dependencies['proper-lockfile'], '4.1.2');
  assert.equal(lockfile.packages[''].engines.node, '>=18');
  assert.equal(lockfile.packages[''].dependencies.playwright, '1.55.1');
  assert.equal(lockfile.packages[''].dependencies['proper-lockfile'], '4.1.2');
  assert.equal(lockfile.packages['node_modules/proper-lockfile'].version, '4.1.2');
  assert.equal(lockfile.packages['node_modules/playwright'].engines.node, '>=18');
});

async function listCommitCandidates() {
  try {
    const { stdout: gitRoot } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    const resolvedGitRoot = path.resolve(gitRoot.trim());
    const relativeProjectRoot = path.relative(resolvedGitRoot, PROJECT_ROOT);
    if (relativeProjectRoot.startsWith('..') || path.isAbsolute(relativeProjectRoot)) {
      throw new Error('project is outside Git root');
    }
    const { stdout } = await execFileAsync('git', [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
      '--', relativeProjectRoot || '.',
    ], { cwd: resolvedGitRoot, encoding: 'utf8' });
    return stdout.split('\0').filter(Boolean).map((file) => path.join(resolvedGitRoot, file));
  } catch {
    return listArchiveCandidates(PROJECT_ROOT);
  }
}

const ignoredArchiveDirectories = new Set([
  '.git',
  '.linkedin-browser-profile',
  'node_modules',
]);

function isIgnoredArchiveFile(name) {
  return name === '.env'
    || name.startsWith('.env.tmp-')
    || name === '.linkedin-unread-outbox.json'
    || name.startsWith('.linkedin-unread-outbox.json.tmp-')
    || name === '.linkedin-unread-outbox.lock'
    || name === '.linkedin-timestamp-work.json'
    || name.startsWith('.linkedin-timestamp-work.json.tmp-')
    || name === '.linkedin-timestamp-results.json'
    || name.startsWith('.linkedin-timestamp-results.json.tmp-');
}

async function listArchiveCandidates(directory) {
  const candidates = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredArchiveDirectories.has(entry.name)) continue;
    if (entry.isFile() && isIgnoredArchiveFile(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) candidates.push(...await listArchiveCandidates(absolutePath));
    if (entry.isFile()) candidates.push(absolutePath);
  }
  return candidates;
}

test('archive fallback works without Git metadata and excludes local secrets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-skill-archive-'));
  try {
    await fs.mkdir(path.join(directory, 'src'));
    await fs.mkdir(path.join(directory, 'node_modules'));
    await fs.writeFile(path.join(directory, 'SKILL.md'), 'safe');
    await fs.writeFile(path.join(directory, 'src', 'cli.js'), 'safe');
    await fs.writeFile(path.join(directory, '.env'), 'private');
    await fs.writeFile(path.join(directory, '.env.tmp-123'), 'private');
    await fs.writeFile(path.join(directory, '.linkedin-unread-outbox.json'), 'private');
    await fs.writeFile(path.join(directory, '.linkedin-unread-outbox.lock'), 'private');
    await fs.writeFile(path.join(directory, '.linkedin-timestamp-work.json'), 'private');
    await fs.writeFile(path.join(directory, '.linkedin-timestamp-results.json'), 'private');
    await fs.writeFile(path.join(directory, 'node_modules', 'dependency.js'), 'ignored');

    const relative = (await listArchiveCandidates(directory))
      .map((file) => path.relative(directory, file))
      .sort();
    assert.deepEqual(relative, ['SKILL.md', path.join('src', 'cli.js')]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const forbiddenPrivateContent = [
  'Ada Lovelace',
  'Grace Hopper',
  'Hello from LinkedIn',
  'Hello\nfrom LinkedIn 👋',
  'Hello<br>from LinkedIn 👋',
  'Only visible message',
  'Private Ada message preview',
  'Private Grace message content',
  'Private ignored title',
  'Private image description',
  'Private preview one',
  'Private preview two',
  'Private restart preview',
  'Earlier inbound message',
  'Earlier outbound message',
  'Hidden stale private message',
  'Hidden stale thread',
  'Tooltip timestamp message',
];

function syntheticContentAllowed(relativePath) {
  return (
    relativePath === '.env.example'
      || relativePath.startsWith('fixtures/')
      || relativePath.startsWith('test/')
  );
}

function clearlySynthetic(value) {
  return /(?:example|test|fake|fixture|placeholder|replace-me|redacted|sentinel|injected|private-call-secret|private\\nsecret|private\s+secret|shared-secret|token=part|xxx)/i
    .test(value);
}

function hasUnsafeMatch(text, pattern, synthetic) {
  for (const match of text.matchAll(pattern)) {
    if (!synthetic || !clearlySynthetic(match[0])) return true;
  }
  return false;
}

async function resolveCommitCandidateViolations(candidates, root = PROJECT_ROOT) {
  const violations = [];
  const legacyWebhookMiddleLabel = ['sla', 'ck'].join('');
  const legacyWebhookHost = ['hooks', legacyWebhookMiddleLabel, 'com']
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\.');
  const legacyWebhookPattern = new RegExp(
    `https:\\/\\/${legacyWebhookHost}\\/services\\/[A-Za-z0-9_-]+\\/[A-Za-z0-9_-]+\\/[A-Za-z0-9_-]+`,
    'gi',
  );
  const legacyTokenPattern = new RegExp(
    `\\b${['xox', '[a-z]'].join('')}-[A-Za-z0-9-]{10,}\\b`,
    'gi',
  );
  for (const file of candidates) {
    const relativePath = path.relative(root, file).split(path.sep).join('/');
    const basename = path.posix.basename(relativePath);
    const synthetic = syntheticContentAllowed(relativePath);
    const forbiddenArtifact = basename === '.env'
      || basename.startsWith('.env.tmp-')
      || relativePath.includes('/.linkedin-browser-profile/')
      || relativePath.startsWith('.linkedin-browser-profile/')
      || /(?:^|\/)\.linkedin-unread-outbox\.(?:json(?:\.tmp-.*)?|lock.*)$/.test(relativePath)
      || /^\.linkedin-timestamp-(?:work|results)\.json(?:\.tmp-.*)?$/.test(basename);
    if (forbiddenArtifact) violations.push(`${relativePath}: private runtime artifact`);

    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const privatePathPatterns = [
      /\/Users\/[A-Za-z0-9._-]+\//g,
      /\/home\/[A-Za-z0-9._-]+\//g,
      /\b[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+[\\/]/gi,
    ];
    const credentialPatterns = [
      legacyWebhookPattern,
      legacyTokenPattern,
      /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
      /\bAKIA[A-Z0-9]{16}\b/g,
      /\bsk-(?:live-)?[A-Za-z0-9_-]{20,}\b/gi,
      /PORTAL_CALL_SECRET[ \t]*=[ \t]*[^\s#]+/gi,
      /(?:["']?portalCallSecret["']?|["']?callSecret["']?)\s*[:=]\s*["'][^"']+["']/gi,
      /PORTAL_WEBHOOK_URL[ \t]*=[ \t]*https?:\/\/[^\s#]+/gi,
      /["']?portalWebhookUrl["']?\s*[:=]\s*["']https?:\/\/[^"']+["']/gi,
      /(?:api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret)[ \t]*[:=][ \t]*(?:["'][^"']+["']|[A-Za-z0-9_./+=-]+)/gi,
    ];
    const unsafePath = privatePathPatterns.some((pattern) => hasUnsafeMatch(text, pattern, synthetic));
    const unsafeCredentialPattern = credentialPatterns.findIndex((pattern) => (
      hasUnsafeMatch(text, pattern, synthetic)
    ));
    const privateKey = /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text);
    if (unsafePath || unsafeCredentialPattern >= 0 || privateKey) {
      const category = unsafePath ? 'machine path'
        : privateKey ? 'private key' : `credential pattern ${unsafeCredentialPattern}`;
      violations.push(`${relativePath}: ${category}`);
    }
    if (!synthetic && forbiddenPrivateContent.some((value) => text.includes(value))) {
      violations.push(`${relativePath}: private fixture content outside fixtures/tests`);
    }
  }
  return violations;
}

test('repository privacy classifier rejects runtime artifacts and private production text', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-privacy-gate-'));
  try {
    const actualSecret = ['actual', 'production', 'secret'].join('-');
    const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const portalSecretAssignment = `${['PORTAL', 'CALL', 'SECRET'].join('_')}=${actualSecret}`;
    const portalUrl = `${['https://portal', 'company', 'invalid'].join('.')}/hook`;
    const genericSecret = ['actual', 'value', '123'].join('-');
    const legacyMiddleLabel = ['sla', 'ck'].join('');
    const legacyWebhook = [
      `https://${['hooks', legacyMiddleLabel, 'com'].join('.')}/services`,
      'T0123456789',
      'B0123456789',
      'abcdefghijklmnopqrstuvwx',
    ].join('/');
    const splitLabelLookalike = [
      `https://${['hooks', 'sla', 'ck', 'com'].join('.')}/services`,
      'T0123456789',
      'B0123456789',
      'abcdefghijklmnopqrstuvwx',
    ].join('/');
    const legacyToken = [['xox', 'b'].join(''), '1234567890abcdefghijkl'].join('-');
    const genericAssignments = [
      `${['API', 'TOKEN'].join('_')}=${genericSecret}`,
      `${['api', 'key'].join('_')}: ${genericSecret}`,
      `${['access', 'token'].join('_')} = ${genericSecret}`,
    ];
    const familyTokens = {
      githubToken: `ghp_${'a'.repeat(24)}`,
      awsKey: `AKIA${'A1'.repeat(8)}`,
      stripeStyleKey: ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
    };
    const forbiddenCases = [
      ['.env', 'private'],
      ['.env.tmp-', 'private'],
      ['.linkedin-browser-profile/Default/Cookies', 'binary-ish'],
      ['.linkedin-unread-outbox.json', 'private'],
      ['.linkedin-unread-outbox.json.tmp-', 'private'],
      ['.linkedin-unread-outbox.lock.tmp-', 'private'],
      ['.linkedin-timestamp-work.json', 'private'],
      ['.linkedin-timestamp-results.json.tmp-', 'private'],
      ['src/mac-home.js', `const path = "${['', 'Users', 'actual-user', 'private'].join('/')}"`],
      ['src/linux-home.js', `const path = "${['', 'home', 'actual-user', 'private'].join('/')}"`],
      ['src/windows-home.js', `const path = "${['C:', 'Users', 'actual-user', 'private'].join('/')}"`],
      ['src/windows-home-backslash.js', `const path = "${['C:', 'Users', 'actual-user', 'private'].join('\\')}"`],
      ['src/legacy-webhook.js', legacyWebhook],
      ['src/legacy-token.txt', legacyToken],
      ['src/portal-env.js', portalSecretAssignment],
      ['src/portal-json.js', JSON.stringify({ portalCallSecret: actualSecret })],
      ['src/portal-url.js', JSON.stringify({ portalWebhookUrl: portalUrl })],
      ...genericAssignments.map((content, index) => [`src/generic-token-${index}.env`, content]),
      ...Object.entries(familyTokens).map(([name, content]) => [`src/${name}.txt`, content]),
      ['src/private-key.pem', `${privateKeyHeader}\nactual-key-material`],
      ...forbiddenPrivateContent.map((content, index) => [
        `src/private-content-${index}.txt`,
        content,
      ]),
    ];
    const forbiddenFiles = [];
    for (const [relativePath, content] of forbiddenCases) {
      const file = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      forbiddenFiles.push(file);
    }
    const violations = await resolveCommitCandidateViolations(forbiddenFiles, directory);
    for (const [relativePath] of forbiddenCases) {
      assert.equal(
        violations.some((violation) => violation.startsWith(`${relativePath}:`)),
        true,
        relativePath,
      );
    }

    const allowedCases = [
      ['src/split-label-lookalike.js', splitLabelLookalike],
      [
        '.env.example',
        'PORTAL_WEBHOOK_URL=https://portal.example.test/hook\nPORTAL_CALL_SECRET=replace-me',
      ],
      [
        'fixtures/sanitized.html',
        'Private Grace message content\nHello\nfrom LinkedIn 👋\nOnly visible message',
      ],
      [
        'test/sanitized.test.js',
        'const home = "/Users/example/private"; const API_TOKEN = "test-placeholder"; '
          + 'const config = { portalCallSecret: "private-call-secret" };',
      ],
    ];
    for (const [relativePath, content] of allowedCases) {
      const file = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      assert.deepEqual(
        await resolveCommitCandidateViolations([file], directory),
        [],
        relativePath,
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('commit candidates contain no private artifacts, credentials, machine paths, or fixture content', async () => {
  const gitignore = await fs.readFile(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  for (const pattern of [
    '.env',
    '.env.tmp-*',
    '.linkedin-browser-profile/',
    '.linkedin-unread-outbox.json',
    '.linkedin-unread-outbox.json.tmp-*',
    '.linkedin-unread-outbox.lock*',
    '.linkedin-timestamp-work.json',
    '.linkedin-timestamp-work.json.tmp-*',
    '.linkedin-timestamp-results.json',
    '.linkedin-timestamp-results.json.tmp-*',
  ]) {
    assert.equal(gitignore.split('\n').includes(pattern), true, `missing ignore pattern: ${pattern}`);
  }
  assert.deepEqual(await resolveCommitCandidateViolations(await listCommitCandidates()), []);
});
