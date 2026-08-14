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
  'package.json',
  path.join('src', 'cli.js'),
  path.join('references', 'automation-setup.md'),
];
const requiredDirectories = ['agents', 'fixtures', 'references', 'src', 'test'];
const ignoredCopyNames = new Set([
  '.env',
  '.git',
  '.linkedin-browser-profile',
  'node_modules',
]);

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function copyRepository(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (ignoredCopyNames.has(entry.name) || entry.name.startsWith('.env.tmp-')) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyRepository(sourcePath, destinationPath);
    if (entry.isFile()) await fs.copyFile(sourcePath, destinationPath);
  }
}

test('repository exposes a complete named skill path', async () => {
  for (const marker of requiredMarkers) {
    assert.equal(await exists(path.join(skillRoot, marker)), true, marker);
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

test('Git sparse checkout of the named path contains the complete skill', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-sparse-layout-'));
  try {
    const source = path.join(temporaryRoot, 'source');
    const clone = path.join(temporaryRoot, 'clone');
    await copyRepository(repositoryRoot, source);
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: source });
    await execFileAsync('git', ['add', '.'], { cwd: source });
    await execFileAsync('git', [
      '-c', 'user.name=Skill Test',
      '-c', 'user.email=skill-test@example.invalid',
      'commit', '-m', 'fixture',
    ], { cwd: source });
    await execFileAsync('git', [
      'clone', '--filter=blob:none', '--depth', '1', '--sparse', '--single-branch',
      pathToFileURL(source).href, clone,
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

test('skill collects the webhook in chat and transfers it only through hidden PTY input', async () => {
  const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const installVerification = skill.indexOf('## Verify the installation');
  const dependencySetup = skill.indexOf('npm install');

  assert.notEqual(installVerification, -1);
  assert.notEqual(dependencySetup, -1);
  assert.ok(installVerification < dependencySetup);
  assert.match(skill, /references\/automation-setup\.md/);
  assert.match(skill, /stop immediately/i);
  assert.match(skill, /Please provide `SLACK_WEBHOOK_URL`\./);
  assert.match(skill, /chat history/i);
  assert.match(skill, /interactive PTY/i);
  assert.match(skill, /hidden input/i);
  assert.match(skill, /shell command/i);
  assert.match(skill, /command-line argument/i);
  assert.match(skill, /environment assignment/i);
  assert.match(skill, /patch/i);
  assert.match(skill, /automation prompt/i);
  assert.doesNotMatch(skill, /paste their current webhook into that hidden prompt/i);
});
