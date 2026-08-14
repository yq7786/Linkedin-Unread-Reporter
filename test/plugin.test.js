import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { PROJECT_ROOT } from '../src/config.js';

const pluginRoot = path.join(PROJECT_ROOT, 'plugins', 'linkedin-unread-reporter');
const skillRoot = path.join(pluginRoot, 'skills', 'linkedin-unread-reporter');
const execFileAsync = promisify(execFile);

test('plugin manifest exposes only the bundled skill', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'linkedin-unread-reporter');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.interface.category, 'Productivity');
  assert.deepEqual(manifest.interface.capabilities, ['Read-only browser scan', 'Local Slack report']);
  assert.equal('mcpServers' in manifest, false);
  assert.equal('hooks' in manifest, false);
  assert.equal('apps' in manifest, false);
});

test('repo marketplace points to the portable local plugin', async () => {
  const marketplace = JSON.parse(await fs.readFile(
    path.join(PROJECT_ROOT, '.agents', 'plugins', 'marketplace.json'),
    'utf8',
  ));
  const entry = marketplace.plugins.find(({ name }) => name === 'linkedin-unread-reporter');
  assert.deepEqual(entry, {
    name: 'linkedin-unread-reporter',
    source: { source: 'local', path: './plugins/linkedin-unread-reporter' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  });
});

test('skill metadata and instructions are complete and portable', async () => {
  const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const metadata = await fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  const automation = await fs.readFile(path.join(skillRoot, 'references', 'automation-setup.md'), 'utf8');

  assert.match(skill, /^---\nname: linkedin-unread-reporter\ndescription: .+\n---/);
  assert.match(skill, /npm run configure/);
  assert.match(skill, /never open/i);
  assert.match(metadata, /\$linkedin-unread-reporter/);
  assert.match(automation, /IANA timezone/);
  assert.match(automation, /local/i);
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
