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

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(target));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

async function copyCurrentSkill(destination) {
  const { stdout } = await execFileAsync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'linkedin-unread-reporter',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  for (const relativePath of stdout.split('\0').filter(Boolean)) {
    const source = path.join(repositoryRoot, relativePath);
    if (!await exists(source) || !(await fs.stat(source)).isFile()) continue;
    const installedRelative = path.relative('linkedin-unread-reporter', relativePath);
    const target = path.join(destination, installedRelative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

function isPrivateOrGenerated(relativePath) {
  const parts = relativePath.split('/');
  const basename = parts.at(-1);
  return parts.includes('node_modules')
    || parts.includes('.linkedin-browser-profile')
    || parts.includes('.git')
    || parts.includes('playwright-report')
    || parts.includes('test-results')
    || parts.includes('coverage')
    || basename === '.env'
    || basename.startsWith('.env.tmp-')
    || basename.startsWith('.linkedin-unread-outbox.')
    || basename.startsWith('.linkedin-timestamp-work.')
    || basename.startsWith('.linkedin-timestamp-results.');
}

async function installedTextFiles(installed) {
  const textFiles = [];
  for (const file of await listFiles(installed)) {
    const relativePath = path.relative(installed, file).split(path.sep).join('/');
    if (isPrivateOrGenerated(relativePath)) continue;
    const contents = await fs.readFile(file);
    if (!contents.includes(0)) textFiles.push([relativePath, contents.toString('utf8')]);
  }
  return textFiles;
}

async function runPortableChecks(installed) {
  const manifest = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.check, 'node --check src/*.js && node test/run-tests.js');
  assert.doesNotMatch(manifest.scripts.check, /\.\.\//);

  const sourceFiles = (await listFiles(path.join(installed, 'src')))
    .filter((file) => file.endsWith('.js'));
  for (const file of sourceFiles) {
    await execFileAsync(process.execPath, ['--check', file], { cwd: installed });
  }
  for (const testFile of [
    'config.test.js',
    'configure.test.js',
    'linkedin-state.test.js',
    'messages.test.js',
  ]) {
    await execFileAsync(process.execPath, [path.join('test', testFile)], { cwd: installed });
  }
}

async function validateInstalledArtifact(installed) {
  for (const marker of requiredMarkers) {
    assert.equal(await exists(path.join(installed, marker)), true, marker);
  }
  assert.equal(await exists(path.join(installed, 'README.md')), false);
  for (const privatePath of [
    'node_modules',
    '.env',
    '.linkedin-browser-profile',
    '.linkedin-unread-outbox.json',
    '.linkedin-unread-outbox.lock',
    '.linkedin-timestamp-work.json',
    '.linkedin-timestamp-results.json',
  ]) {
    assert.equal(await exists(path.join(installed, privatePath)), false, privatePath);
  }

  const files = await installedTextFiles(installed);
  const scanned = new Set(files.map(([relativePath]) => relativePath));
  for (const required of ['package.json', '.env.example', '.gitignore', 'SKILL.md']) {
    assert.equal(scanned.has(required), true, `not scanned: ${required}`);
  }
  for (const prefix of ['agents/', 'fixtures/', 'references/', 'src/', 'test/']) {
    assert.equal([...scanned].some((relativePath) => relativePath.startsWith(prefix)), true, prefix);
  }

  const legacyProduct = ['Sla', 'ck'].join('');
  const legacyIdentifier = ['configure', legacyProduct].join('');
  const legacyConfigKey = [legacyProduct.toUpperCase(), 'WEBHOOK_URL'].join('_');
  for (const [relativePath, text] of files) {
    assert.equal(text.toLowerCase().includes(legacyProduct.toLowerCase()), false, relativePath);
    assert.equal(text.includes(legacyIdentifier), false, relativePath);
    assert.equal(text.includes(legacyConfigKey), false, relativePath);
  }
  await runPortableChecks(installed);
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
    '.linkedin-unread-outbox.lock*',
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

    const currentArchive = path.join(temporaryRoot, 'current-worktree-skill');
    await copyCurrentSkill(currentArchive);
    await validateInstalledArtifact(currentArchive);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill-installer Git boundary validates and copies the current worktree skill', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-installer-layout-'));
  try {
    await execFileAsync('python3', [
      path.join(repositoryRoot, 'repository-test', 'install-boundary.py'),
      'git',
      repositoryRoot,
      temporaryRoot,
    ]);
    const installed = path.join(temporaryRoot, 'linkedin-unread-reporter');
    await validateInstalledArtifact(installed);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill-installer download boundary validates and copies the current worktree skill', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-download-layout-'));
  try {
    await execFileAsync('python3', [
      path.join(repositoryRoot, 'repository-test', 'install-boundary.py'),
      'download',
      repositoryRoot,
      temporaryRoot,
    ]);
    const installed = path.join(temporaryRoot, 'linkedin-unread-reporter');
    await validateInstalledArtifact(installed);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill collects portal credentials in chat and transfers them only through hidden PTY input', async () => {
  const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const installVerification = skill.indexOf('## Verify the installation');
  const dependencySetup = skill.indexOf('npm install');

  assert.notEqual(installVerification, -1);
  assert.notEqual(dependencySetup, -1);
  assert.ok(installVerification < dependencySetup);
  assert.match(skill, /- `SKILL\.md`/);
  assert.match(skill, /references\/automation-setup\.md/);
  assert.match(skill, /stop immediately/i);
  assert.match(skill, /Please provide `PORTAL_WEBHOOK_URL` and `PORTAL_CALL_SECRET` together/);
  assert.match(skill, /PORTAL_WEBHOOK_URL: <https-url>/);
  assert.match(skill, /PORTAL_CALL_SECRET: <secret>/);
  assert.doesNotMatch(skill, /Please provide the Portal Webhook URL\./);
  assert.doesNotMatch(skill, /When its first hidden prompt appears/);
  assert.doesNotMatch(skill, /When its second hidden prompt appears/);
  assert.match(skill, /PORTAL_WEBHOOK_URL/);
  assert.match(skill, /HTTPS/);
  assert.match(skill, /chat history/i);
  assert.match(skill, /interactive PTY/i);
  assert.match(skill, /hidden input/i);
  assert.match(skill, /Never put either value in a shell command, command-line argument, environment assignment, patch, log, automation prompt, or task output\./);
  assert.match(skill, /write access to the installed skill directory/);
  assert.match(skill, /Never quote, summarize, visibly validate, or repeat either value/i);
  assert.match(skill, /operating agent may read/i);
  assert.doesNotMatch(skill, /must never be read or summarized by Codex/);
  assert.doesNotMatch(skill, /paste their current webhook into that hidden prompt/i);
});

test('package check is portable and depends only on installed resources', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(skillRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.check, 'node --check src/*.js && node test/run-tests.js');
  assert.doesNotMatch(manifest.scripts.check, /\.\.\//);
});

test('live installed resources expose only the portal setup contract', async () => {
  const legacyProduct = ['Sla', 'ck'].join('');
  const legacyIdentifier = ['configure', legacyProduct].join('');
  const legacyConfigKey = [legacyProduct.toUpperCase(), 'WEBHOOK_URL'].join('_');
  for (const [relativePath, text] of await installedTextFiles(skillRoot)) {
    assert.equal(text.toLowerCase().includes(legacyProduct.toLowerCase()), false, relativePath);
    assert.equal(text.includes(legacyIdentifier), false, relativePath);
    assert.equal(text.includes(legacyConfigKey), false, relativePath);
  }
});
