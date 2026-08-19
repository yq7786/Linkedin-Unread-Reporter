import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(repositoryRoot, 'linkedin-unread-reporter');
const requiredMarkers = [
  'SKILL.md',
  '.env.example',
  '.gitignore',
  'LICENSE',
  'package-lock.json',
  'package.json',
  path.join('src', 'cli.js'),
  path.join('references', 'automation-setup.md'),
];
const requiredDirectories = ['agents', 'fixtures', 'references', 'src', 'test'];

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

test('repository exposes a complete named skill path', async () => {
  const { stdout: committedFiles } = await execFileAsync('git', [
    'ls-tree', '-r', '--name-only', 'HEAD', '--', 'linkedin-unread-reporter',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  for (const marker of requiredMarkers) {
    assert.equal(await exists(path.join(skillRoot, marker)), true, marker);
    assert.match(committedFiles, new RegExp(`^linkedin-unread-reporter/${marker.replaceAll('\\', '/').replaceAll('.', '\\.')}$`, 'm'));
  }
  for (const directory of requiredDirectories) {
    assert.equal((await fs.stat(path.join(skillRoot, directory))).isDirectory(), true, directory);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(skillRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'linkedin-unread-reporter');

  const readme = await fs.readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
  assert.match(readme, /--path linkedin-unread-reporter/);
  assert.doesNotMatch(readme, /--path \.([\s`]|$)/);
});

test('packaging ignores all private portal ingestion state files', async () => {
  const gitignore = await fs.readFile(path.join(skillRoot, '.gitignore'), 'utf8');
  for (const pattern of [
    '.linkedin-unread-outbox.json',
    '.linkedin-unread-outbox.json.tmp-*',
    '.linkedin-unread-outbox.lock',
    '.linkedin-timestamp-work.json',
    '.linkedin-timestamp-work.json.tmp-*',
    '.linkedin-timestamp-results.json',
    '.linkedin-timestamp-results.json.tmp-*',
  ]) {
    assert.equal(gitignore.split(/\r?\n/).includes(pattern), true, pattern);
  }
});

test('Git sparse checkout of the named path contains the complete skill', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-sparse-layout-'));
  try {
    const clone = path.join(temporaryRoot, 'clone');
    await execFileAsync('git', [
      'clone', '--filter=blob:none', '--depth', '1', '--sparse', '--single-branch',
      pathToFileURL(repositoryRoot).href, clone,
    ]);
    await execFileAsync('git', ['sparse-checkout', 'set', 'linkedin-unread-reporter'], {
      cwd: clone,
    });

    for (const marker of requiredMarkers) {
      assert.equal(
        await exists(path.join(clone, 'linkedin-unread-reporter', marker)),
        true,
        marker,
      );
    }
    assert.equal(
      await exists(path.join(clone, 'linkedin-unread-reporter', 'README.md')),
      false,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill-installer Git boundary validates and copies the committed named skill', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-installer-layout-'));
  try {
    await execFileAsync('python3', [
      path.join(repositoryRoot, 'repository-test', 'install-boundary.py'),
      'git',
      repositoryRoot,
      temporaryRoot,
    ]);
    const installed = path.join(temporaryRoot, 'linkedin-unread-reporter');
    for (const marker of requiredMarkers) {
      assert.equal(await exists(path.join(installed, marker)), true, marker);
    }
    assert.equal(await exists(path.join(installed, 'README.md')), false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill-installer download boundary validates and copies the committed named skill', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-download-layout-'));
  try {
    await execFileAsync('python3', [
      path.join(repositoryRoot, 'repository-test', 'install-boundary.py'),
      'download',
      repositoryRoot,
      temporaryRoot,
    ]);
    const installed = path.join(temporaryRoot, 'linkedin-unread-reporter');
    for (const marker of requiredMarkers) {
      assert.equal(await exists(path.join(installed, marker)), true, marker);
    }
    assert.equal(await exists(path.join(installed, 'README.md')), false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill collects the webhook in chat and transfers it only through hidden PTY input', async () => {
  const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const installVerification = skill.indexOf('## Verify the installation');
  const dependencySetup = skill.indexOf('npm install');

  assert.notEqual(installVerification, -1);
  assert.notEqual(dependencySetup, -1);
  assert.ok(installVerification < dependencySetup);
  assert.match(skill, /- `SKILL\.md`/);
  assert.match(skill, /references\/automation-setup\.md/);
  assert.match(skill, /stop immediately/i);
  assert.match(skill, /Please provide `SLACK_WEBHOOK_URL`\./);
  assert.match(skill, /chat history/i);
  assert.match(skill, /interactive PTY/i);
  assert.match(skill, /hidden input/i);
  assert.match(
    skill,
    /Never place the value in a shell command, command-line argument, environment assignment, patch, log, automation prompt, or task output\./,
  );
  assert.match(skill, /do not quote, summarize, validate visibly, or repeat it/i);
  assert.match(skill, /Do not read `\.env` back/i);
  assert.doesNotMatch(skill, /paste their current webhook into that hidden prompt/i);
});
