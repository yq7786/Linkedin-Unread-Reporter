# LinkedIn Unread Reporter Implementation Plan

> **Execution mode:** Inline implementation in this task, as requested by the user.

**Goal:** Ship a public GitHub-ready Node.js reporter and bundled Codex plugin that safely scans LinkedIn's unread conversation list and posts a privacy-minimized Slack report on local schedules.

**Architecture:** Keep browser interaction, Slack delivery, configuration, and formatting behind small modules. Put decision-heavy behavior in pure functions covered by Node's built-in test runner. Use one headed persistent Playwright profile, fail closed when the unread-list invariants do not hold, and keep secrets/browser state exclusively in gitignored local files.

**Technology:** Node.js ESM, Playwright, Node built-in test runner, Slack incoming webhooks, Codex plugin/skill manifests, local Codex automations.

---

## Task 1: Establish the safe project shell

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `LICENSE`
- Create: `README.md`

- [ ] Add pinned Node and Playwright metadata plus `test`, `check`, `configure`, `scan`, `slack-test`, and `report` scripts.
- [ ] Gitignore `.env`, `.linkedin-browser-profile/`, Playwright output, coverage, and dependencies.
- [ ] Document the policy risk, local-machine requirements, privacy boundaries, install flow, and non-API approach.
- [ ] Verify committed files contain no webhook or machine-specific home path.

## Task 2: Build configuration test-first

**Files:**
- Create: `test/config.test.js`
- Create: `src/config.js`

- [ ] Write failing tests for defaults, relative path resolution from the repository root, required webhook behavior, webhook validation, numeric bounds, and secret-safe errors.
- [ ] Run `node --test test/config.test.js` and confirm the expected failures.
- [ ] Implement environment loading and validation without logging the webhook.
- [ ] Re-run the focused tests to green.

## Task 3: Build local secret collection test-first

**Files:**
- Create: `test/configure.test.js`
- Create: `src/configure.js`

- [ ] Write failing tests for creating/updating `.env`, preserving unrelated settings, mode `0600`, non-echoed input abstraction, and webhook redaction.
- [ ] Run the focused tests and confirm failure.
- [ ] Implement atomic local configuration persistence and an interactive hidden prompt.
- [ ] Re-run the focused tests to green.

## Task 4: Define LinkedIn fixtures and row eligibility test-first

**Files:**
- Create: `fixtures/unread-list.html`
- Create: `fixtures/blocked-login.html`
- Create: `fixtures/checkpoint.html`
- Create: `test/linkedin-state.test.js`
- Create: `src/linkedin-state.js`

- [ ] Write failing tests for unread-filter state, no-active-row/no-detail-pane invariants, unread eligibility, sponsored/automated exclusion, malformed rows, duplicate names, and blocker classification.
- [ ] Run the focused tests and confirm failure.
- [ ] Implement pure classification and normalization helpers that never retain preview text.
- [ ] Re-run the focused tests to green.

## Task 5: Build the bounded scanner test-first

**Files:**
- Create: `test/scanner.test.js`
- Create: `src/scanner.js`

- [ ] Write a fake page/list adapter and failing tests for direct unread navigation, invariant failure, stable-list termination, load-more handling, deduplication by row identity, exact-50 completion, early cap truncation, and zero rows.
- [ ] Run the focused tests and confirm failure.
- [ ] Implement the orchestration loop with no row clicks and a hard cap of 50 qualifying conversations.
- [ ] Re-run the focused tests to green.

## Task 6: Build report formatting test-first

**Files:**
- Create: `test/report.test.js`
- Create: `src/report.js`

- [ ] Write failing snapshot-style assertions for zero, normal, exact duplicate names, Unicode-safe ordering, and truncated results.
- [ ] Confirm the exact heading `LinkedIn unread message:` and one shared inbox link.
- [ ] Implement count-preserving duplicate grouping and Adelaide/IANA timezone formatting.
- [ ] Re-run the focused tests to green.

## Task 7: Build Slack delivery test-first

**Files:**
- Create: `test/slack.test.js`
- Create: `src/slack.js`

- [ ] Write failing tests with an injected `fetch` for JSON payloads, success, non-2xx errors, network errors, and webhook redaction.
- [ ] Run the focused tests and confirm failure.
- [ ] Implement the incoming-webhook publisher and labeled test message.
- [ ] Re-run the focused tests to green.

## Task 8: Add the Playwright adapter and blocker recovery test-first

**Files:**
- Create: `test/browser.test.js`
- Create: `src/browser.js`

- [ ] Write failing adapter tests using fakes for persistent headed context settings, blocker polling, 15-minute timeout behavior, sanitized diagnostics, and guaranteed browser closure.
- [ ] Run the focused tests and confirm failure.
- [ ] Implement Playwright-backed list inspection using explicit selectors and accessibility fallbacks, without any conversation-row click.
- [ ] Re-run the focused tests to green.

## Task 9: Wire the CLI test-first

**Files:**
- Create: `test/cli.test.js`
- Create: `src/cli.js`

- [ ] Write failing tests for `configure`, `scan`, `slack-test`, and `scheduled-report`; interactive versus non-interactive configuration; exit codes; and sanitized output.
- [ ] Run the focused tests and confirm failure.
- [ ] Implement dependency-injected command handlers and a thin executable entry point.
- [ ] Re-run the focused tests, then run the complete test suite.

## Task 10: Scaffold and author the reusable Codex plugin

**Files:**
- Create via official scaffolds: `plugins/linkedin-unread-reporter/.codex-plugin/plugin.json`
- Create via official scaffolds: `plugins/linkedin-unread-reporter/skills/linkedin-unread-reporter/SKILL.md`
- Create: `plugins/linkedin-unread-reporter/skills/linkedin-unread-reporter/agents/openai.yaml`
- Create: `plugins/linkedin-unread-reporter/skills/linkedin-unread-reporter/references/automation-setup.md`
- Create: `.agents/plugins/marketplace.json`
- Create: `test/plugin.test.js`

- [ ] Use the plugin-creator and skill-creator scaffold scripts rather than hand-building their base layouts.
- [ ] Write failing repository tests for manifest identity, marketplace source/policies, skill metadata, portable instructions, and forbidden secret/path patterns.
- [ ] Author the minimal procedural skill and automation reference.
- [ ] Generate UI metadata, run the official skill and plugin validators, and make repository tests green.

## Task 11: Verify locally and against the live unread page

**Files:**
- Modify selectors/fixtures/tests only if verification proves drift.

- [ ] Install the pinned dependency and browser runtime.
- [ ] Run `npm test`, syntax/static checks, plugin validation, and a repository secret scan.
- [ ] Run a supervised headed dry scan against `https://www.linkedin.com/messaging/?filter=unread`.
- [ ] Confirm the unread filter is pressed, no row becomes active, no detail pane appears, and the before/after unread count is unchanged.
- [ ] If LinkedIn requests login/CAPTCHA/checkpoint, instruct the user in the visible session and wait up to 15 minutes.

## Task 12: Configure Slack and scheduling

**Files:**
- Local-only: `.env`
- Local-only: `.linkedin-browser-profile/`
- External local state: three Codex automations

- [ ] Collect the rotated Slack webhook through the hidden local prompt and verify `.env` permissions/gitignore coverage.
- [ ] Send one clearly labeled Slack test message, then one real supervised report.
- [ ] Create three active weekday local automations at 7:00am, 12:00pm, and 4:00pm in `Australia/Adelaide`, all targeting this clone and the same tested CLI.
- [ ] Verify each automation contains no credential and is configured for local execution.

## Task 13: Final quality gate and handoff

**Files:**
- Modify only files implicated by review findings.

- [ ] Request an independent standards/spec code review of the full implementation diff.
- [ ] Fix all critical and important findings with regression tests.
- [ ] Re-run the complete test and validation suite.
- [ ] Commit the implementation in logical units and report the reusable install flow, local setup status, automation status, and any remaining platform-policy limitations.
