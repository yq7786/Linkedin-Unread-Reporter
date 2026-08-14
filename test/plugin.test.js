import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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
  assert.equal(manifest.dependencies.playwright, '1.55.1');
  assert.equal(lockfile.packages[''].engines.node, '>=18');
  assert.equal(lockfile.packages[''].dependencies.playwright, '1.55.1');
  assert.equal(lockfile.packages['node_modules/playwright'].engines.node, '>=18');
});

async function listCommitCandidates() {
  const { stdout } = await execFileAsync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  return stdout.split('\0').filter(Boolean).map((file) => path.join(PROJECT_ROOT, file));
}

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
