# Installer-safe layout and chat webhook implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the reporter under a named installer path that works with Git sparse checkout, and let Codex collect each teammate's Slack webhook in chat before transferring it into the existing hidden configurator.

**Architecture:** Keep GitHub-facing documentation at repository root and move the complete runnable skill into `linkedin-unread-reporter/`. Add a repository-level distribution contract test, retain the installed artifact's Node test suite, and express the chat-to-hidden-PTY secret handoff entirely in `SKILL.md` so the existing atomic `.env` writer remains the only secret-writing implementation.

**Tech Stack:** Codex skills, Node.js 18, Node test runner, Playwright 1.55.1, Git sparse checkout, Slack incoming webhook.

---

### Task 1: Encode the distribution contract

**Files:**
- Create: `repository-test/install-layout.test.js`

- [ ] **Step 1: Write the failing repository-layout test**

Create a Node test that resolves the repository root, expects `linkedin-unread-reporter/SKILL.md`, `src/cli.js`, `.env.example`, `references/automation-setup.md`, and the required directories, and verifies the root README contains `--path linkedin-unread-reporter` without `--path .`. Read the nested skill text and assert that the chat prompt `Please provide \`SLACK_WEBHOOK_URL\`.` appears before `npm install`, that missing markers stop setup, and that webhook transfer uses hidden PTY input rather than commands or environment assignments.

```js
test('repository exposes a complete named skill path', async () => {
  for (const marker of requiredMarkers) {
    assert.equal(await exists(path.join(skillRoot, marker)), true, marker);
  }
  assert.match(readme, /--path linkedin-unread-reporter/);
  assert.doesNotMatch(readme, /--path \.([\s`]|$)/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node repository-test/install-layout.test.js`

Expected: FAIL because `linkedin-unread-reporter/SKILL.md` does not exist yet.

- [ ] **Step 3: Commit the failing contract only after the production change turns it green**

Stage this test together with Task 2 so the branch never contains a deliberately broken commit.

### Task 2: Move the self-contained skill to the named path

**Files:**
- Move into `linkedin-unread-reporter/`: `SKILL.md`, `agents/`, `.env.example`, `fixtures/`, `package.json`, `package-lock.json`, `references/`, `src/`, `test/`
- Create: `linkedin-unread-reporter/.gitignore`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `linkedin-unread-reporter/test/plugin.test.js`

- [ ] **Step 1: Move the tracked artifact without touching local secrets**

Move only tracked runtime and skill files. Leave any root `.env`, `.linkedin-browser-profile/`, and `node_modules/` untouched and untracked. Add nested ignores for `.env`, `.env.tmp-*`, `.linkedin-browser-profile/`, and `node_modules/`; add matching nested paths to the root ignore file.

- [ ] **Step 2: Update source and installed-artifact tests**

Remove the root README assertion from the installed artifact's test suite because GitHub documentation is no longer shipped inside the skill. Keep assertions for skill metadata, Node 18, Playwright, secret scanning, and absence of plugin wrappers scoped to the nested artifact.

- [ ] **Step 3: Update the root README**

Change local commands to start with `cd linkedin-unread-reporter`. Replace the old installer prompt with:

```text
Use $skill-installer to install yq7786/Linkedin-Unread-Reporter with --path linkedin-unread-reporter.
```

Document that a certificate-chain failure should be retried through the supported Git method, never by disabling TLS verification.

- [ ] **Step 4: Run the repository contract and verify GREEN**

Run: `node repository-test/install-layout.test.js`

Expected: all repository-layout tests PASS.

- [ ] **Step 5: Run the installed artifact suite**

Run: `npm test` from `linkedin-unread-reporter/`.

Expected: all existing scanner, browser, configuration, Slack, and distribution tests PASS.

- [ ] **Step 6: Commit the layout migration**

```bash
git add .gitignore README.md repository-test linkedin-unread-reporter
git commit -m "fix: package skill under installer-safe path"
```

### Task 3: Add the approved chat webhook workflow

**Files:**
- Modify: `linkedin-unread-reporter/SKILL.md`
- Modify: `repository-test/install-layout.test.js`

- [ ] **Step 1: Add failing instruction assertions**

Assert that setup asks exactly `Please provide \`SLACK_WEBHOOK_URL\`.`, states that the value remains in chat history, starts `npm run configure` in an interactive PTY, submits the value only through hidden input, does not repeat it, and forbids placement in a shell command, command-line argument, environment assignment, patch, log, or automation prompt.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node repository-test/install-layout.test.js`

Expected: FAIL because the existing skill still tells the user to paste the webhook manually into the terminal.

- [ ] **Step 3: Implement the minimal skill instruction change**

Put fail-fast marker verification before dependency installation. Replace the manual-paste instruction with the approved chat collection and hidden PTY transfer. Preserve the existing configurator, scanning workflow, safety invariants, Slack approval, and fixed schedules.

- [ ] **Step 4: Run focused and complete tests**

Run `node repository-test/install-layout.test.js`, then run `npm test` from `linkedin-unread-reporter/`.

Expected: all tests PASS and no test output contains a webhook value.

- [ ] **Step 5: Commit the workflow update**

```bash
git add repository-test/install-layout.test.js linkedin-unread-reporter/SKILL.md
git commit -m "feat: collect Slack webhook through Codex chat"
```

### Task 4: Verify real installation boundaries and publish

**Files:**
- Modify only if validation finds a defect in files from Tasks 1–3.

- [ ] **Step 1: Validate Node.js and the nested skill**

Run the complete suite with Node.js 18.0.0, run `node --check` on `src/*.js`, and run `quick_validate.py linkedin-unread-reporter`.

Expected: all tests pass, source syntax is valid, and the skill validator prints `Skill is valid!`.

- [ ] **Step 2: Verify Git sparse checkout**

Create a temporary sparse clone of the committed repository, select `linkedin-unread-reporter`, and assert that `src/`, `fixtures/`, `test/`, and `references/` plus all markers exist while root-only documentation is not copied into the skill path.

- [ ] **Step 3: Verify the supported installer Git method**

Create `/private/tmp/linkedin-skill-install-check`, run `install-skill-from-github.py --repo yq7786/Linkedin-Unread-Reporter --path linkedin-unread-reporter --method git --dest /private/tmp/linkedin-skill-install-check` after pushing the commits, then run the marker check and installed test suite from `/private/tmp/linkedin-skill-install-check/linkedin-unread-reporter`. Remove that exact temporary directory after verification.

- [ ] **Step 4: Perform security and repository checks**

Run `git diff --check`, scan committed text for webhook-shaped secrets and machine home paths, and confirm `.env`, browser profile data, and `node_modules` are absent from the commit.

- [ ] **Step 5: Review and push**

Review the changes against the design, push `main` to `origin`, confirm local `HEAD` equals `origin/main`, and leave the two pre-existing uncommitted historical-document deletions untouched.
