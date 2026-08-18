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

  assert.match(skill, /^---\nname: linkedin-unread-reporter\ndescription: .+\n---/);
  assert.match(skill, /npm run configure/);
  assert.match(skill, /npm run login/);
  assert.ok(skill.indexOf('npm run login') < skill.indexOf('npm run scan'));
  assert.match(skill, /never open/i);
  assert.match(skill, /Verify Node\.js 18 or newer/);
  assert.doesNotMatch(skill, /User Agreement/);
  assert.doesNotMatch(skill, /Run `npm test`/);
  assert.match(metadata, /\$linkedin-unread-reporter/);
  assert.match(automation, /Australia\/Adelaide/);
  assert.match(automation, /7:00am/);
  assert.match(automation, /12:00pm/);
  assert.match(automation, /4:00pm/);
  assert.doesNotMatch(automation, /Ask for the user's desired weekdays/);
});

test('package and lockfile require Node 18 with a compatible Playwright pin', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8'));

  assert.equal(manifest.engines.node, '>=18');
  assert.equal(manifest.scripts.test, 'node test/run-tests.js');
  assert.equal(manifest.scripts.login, 'node src/cli.js login');
  assert.match(manifest.scripts.check, /node test\/run-tests\.js/);
  assert.equal(manifest.dependencies.playwright, '1.55.1');
  assert.equal(lockfile.packages[''].engines.node, '>=18');
  assert.equal(lockfile.packages[''].dependencies.playwright, '1.55.1');
  assert.equal(lockfile.packages['node_modules/playwright'].engines.node, '>=18');
});

async function listCommitCandidates() {
  try {
    const { stdout: gitRoot } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    if (path.resolve(gitRoot.trim()) !== path.resolve(PROJECT_ROOT)) throw new Error('not project Git root');
    const { stdout } = await execFileAsync('git', [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    return stdout.split('\0').filter(Boolean).map((file) => path.join(PROJECT_ROOT, file));
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
  return name === '.env' || name.startsWith('.env.tmp-');
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
    await fs.writeFile(path.join(directory, 'node_modules', 'dependency.js'), 'ignored');

    const relative = (await listArchiveCandidates(directory))
      .map((file) => path.relative(directory, file))
      .sort();
    assert.deepEqual(relative, ['SKILL.md', path.join('src', 'cli.js')]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('committed project text contains no machine home path or Slack webhook secret', async () => {
  const gitignore = await fs.readFile(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env\.tmp-\*$/m);
  for (const file of await listCommitCandidates()) {
    if (path.basename(file) === 'package-lock.json') continue;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    assert.equal(/\/Users\/[A-Za-z0-9._-]+\//.test(text), false, file);
    assert.equal(
      /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.test(text),
      false,
      file,
    );
  }
});
