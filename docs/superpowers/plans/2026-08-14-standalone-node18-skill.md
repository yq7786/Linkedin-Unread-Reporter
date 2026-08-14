# Standalone Node.js 18 Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the reporter into a self-contained, GitHub-installable root skill that supports Node.js 18 and automatically creates the fixed Adelaide weekday schedules.

**Architecture:** Keep the runnable Node application at the repository root and promote the existing nested skill instructions, metadata, and automation reference to that same root. Remove the plugin and marketplace wrapper so installing repository path `.` with the explicit name `linkedin-unread-reporter` copies the complete application. Pin the last selected Playwright release that declares Node.js 18 support and validate with the machine's Node 18 runtime.

**Tech Stack:** Node.js 18, Playwright 1.55.1, Node test runner, Codex standalone skills, Codex local scheduled tasks.

---

### Task 1: Specify the standalone root skill

**Files:**
- Modify: `test/plugin.test.js`
- Create: `SKILL.md`
- Create: `agents/openai.yaml`
- Create: `references/automation-setup.md`
- Delete: `.agents/plugins/marketplace.json`
- Delete: `plugins/linkedin-unread-reporter/.codex-plugin/plugin.json`
- Delete: `plugins/linkedin-unread-reporter/skills/linkedin-unread-reporter/SKILL.md`
- Delete: `plugins/linkedin-unread-reporter/skills/linkedin-unread-reporter/agents/openai.yaml`
- Delete: `plugins/linkedin-unread-reporter/skills/linkedin-unread-reporter/references/automation-setup.md`

- [ ] **Step 1: Replace plugin-shape assertions with root-skill assertions**

Assert that root `SKILL.md` has `name: linkedin-unread-reporter`, `agents/openai.yaml` exists, the reporter application markers exist beside it, and plugin/marketplace manifests do not exist. Assert the setup text contains `Verify Node.js 18 or newer` and excludes the removed User Agreement and `Run npm test` setup gates.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/plugin.test.js`

Expected: FAIL because root `SKILL.md` is absent and plugin files still exist.

- [ ] **Step 3: Promote the skill to the repository root**

Create root `SKILL.md` with this setup sequence:

```markdown
1. Verify Node.js 18 or newer, run `npm install`, and install Chromium when absent.
2. Configure the Slack webhook through `npm run configure` when `.env` is missing it.
3. Run a supervised `npm run scan` and require manual login or challenge completion.
4. Obtain approval and run `npm run slack-test`.
5. Run `npm run report` only with approval, then create the fixed schedules after successful delivery.
```

Move the existing UI metadata and automation reference to root `agents/` and `references/`. Remove the plugin wrapper and repository marketplace.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/plugin.test.js`

Expected: PASS for root skill structure, setup wording, secret scan, and absence of plugin artifacts.

### Task 2: Make the runtime genuinely Node.js 18 compatible

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [ ] **Step 1: Tighten the package test expectations**

Add assertions to `test/plugin.test.js` that root `package.json` declares:

```json
{
  "engines": { "node": ">=18" },
  "dependencies": { "playwright": "1.55.1" }
}
```

and that the lockfile root package agrees.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/plugin.test.js`

Expected: FAIL because the current engine and Playwright pin require Node.js 20.

- [ ] **Step 3: Install the compatible Playwright pin**

Run: `npm install playwright@1.55.1 --save-exact`

Then set the root engine to `>=18`, ensure the lockfile root engine matches, and update the README prerequisite to `Node.js 18 or newer` while preserving the user's other uncommitted README edits.

- [ ] **Step 4: Install the matching Chromium runtime**

Run: `npx playwright install chromium`

Expected: the browser binary for Playwright 1.55.1 installs successfully.

- [ ] **Step 5: Run the complete suite with Node.js 18**

Run: `node --version && node --test`

Expected: Node reports version 18.x and all tests pass.

### Task 3: Fix the reusable scheduling workflow

**Files:**
- Modify: `SKILL.md`
- Modify: `references/automation-setup.md`
- Modify: three existing local Codex automations through the automation API

- [ ] **Step 1: Encode the fixed teammate schedule**

Require three active weekday local tasks at 7:00am, 12:00pm, and 4:00pm in `Australia/Adelaide`. Remove questions about alternative weekdays, times, or timezone. Keep prompts credential-free and invoke `$linkedin-unread-reporter` from its installed directory.

- [ ] **Step 2: Update this machine's existing automation prompts**

Preserve each automation's recurrence, status, target project, model, reasoning effort, and notification policy. Replace only the Node.js 20 requirement with Node.js 18 or newer and keep the `scheduled-report` entry point.

- [ ] **Step 3: Inspect all three automations**

Expected: all remain active at the original three weekday times, use the Adelaide local schedule, contain no webhook or contact data, and accept Node.js 18.

### Task 4: Validate installability and finish

**Files:**
- Test: `SKILL.md`
- Test: `agents/openai.yaml`
- Test: repository root application files

- [ ] **Step 1: Validate the root skill**

Run: `python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .`

Expected: `Skill is valid!`

- [ ] **Step 2: Exercise the installer copy boundary locally**

Use the skill installer's validation and copy helpers against the repository root and a temporary destination named `linkedin-unread-reporter`. Confirm the copy contains `SKILL.md`, `package.json`, and `src/cli.js` and excludes ignored local secrets because distribution comes from committed GitHub content.

- [ ] **Step 3: Run final checks**

Run: `node --test`, `git diff --check`, and committed-text scans for Slack webhooks, Node.js 20 setup language, plugin manifests, marketplace entries, and removed setup gates.

Expected: all tests and validators pass; no committed secret or stale distribution artifact is found.

- [ ] **Step 4: Commit only in-scope changes**

Stage the root skill, runtime compatibility files, standalone-skill test, removed plugin artifacts, and README changes. Preserve unrelated user worktree changes, including prior deleted design documents, unless the user explicitly included them.
