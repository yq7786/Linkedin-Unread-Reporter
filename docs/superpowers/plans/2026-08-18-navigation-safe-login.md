# Navigation-Safe LinkedIn Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated login bootstrap that saves the persistent LinkedIn session and make manual checkpoint polling survive ordinary LinkedIn navigations.

**Architecture:** Keep browser lifecycle and page-state polling in `src/browser.js`, exposing a small navigation-error classifier and a readiness-aware recovery loop. Route the new `login` CLI command through the same persistent profile and adapter as scans, but stop after stable unread-inbox readiness so it never reads conversation rows or contacts Slack.

**Tech Stack:** Node.js 18+, ECMAScript modules, Playwright 1.55.1, `node:test`.

**Status:** Implemented and verified on 2026-08-18. The review-driven recovery-ownership correction is recorded in Task 5.

---

### Task 1: Navigation-safe readiness polling

**Files:**
- Modify: `linkedin-unread-reporter/test/browser.test.js`
- Modify: `linkedin-unread-reporter/src/browser.js`

- [ ] **Step 1: Write failing recovery tests**

Add tests showing that the recovery loop retries `Execution context was destroyed` within its existing deadline, waits for two consecutive `{ inboxReady: true }` snapshots, and immediately rethrows unrelated or browser-closed errors.

- [ ] **Step 2: Verify the tests fail for the missing behavior**

Run: `node test/browser.test.js`

Expected: the transient-navigation test rejects with `Execution context was destroyed`, proving the production loop does not yet tolerate the observed race.

- [ ] **Step 3: Implement the narrow retry and readiness state machine**

Add `isTransientNavigationError(error)` with a narrow allowlist for execution-context loss caused by navigation. Update `waitForManualRecovery` to retry only those errors, retain the 15-minute deadline, reset readiness while blocked or transitioning, and return only after two consecutive ready snapshots. Replace separate `page.title()` and `page.evaluate()` calls with one page-context snapshot containing `document.title`, blocker markers, and unread-inbox readiness.

- [ ] **Step 4: Verify browser tests pass**

Run: `node test/browser.test.js`

Expected: all browser unit tests pass without warnings.

### Task 2: Dedicated persistent-profile login command

**Files:**
- Modify: `linkedin-unread-reporter/test/cli.test.js`
- Modify: `linkedin-unread-reporter/src/cli.js`
- Modify: `linkedin-unread-reporter/package.json`

- [ ] **Step 1: Write failing CLI tests**

Add tests proving `login` is accepted without a Slack webhook, invokes only the login dependency, prints no contact data, and leaves scan and Slack dependencies untouched.

- [ ] **Step 2: Verify the tests fail for the missing command**

Run: `node test/cli.test.js`

Expected: the CLI returns usage status `1` for `login`.

- [ ] **Step 3: Implement the login bootstrap**

Add `performBrowserLogin(config)` that launches the existing headed persistent profile, navigates directly to the unread URL, waits for stable inbox readiness and manual blocker clearance, then returns so `withPersistentBrowser` closes and saves the profile. Add `login` to the CLI usage and command routing and expose it as `npm run login`.

- [ ] **Step 4: Verify CLI tests pass**

Run: `node test/cli.test.js`

Expected: all CLI tests pass and the login path performs no scan or Slack call.

### Task 3: Skill workflow and user documentation

**Files:**
- Modify: `linkedin-unread-reporter/test/plugin.test.js`
- Modify: `linkedin-unread-reporter/SKILL.md`
- Modify: `linkedin-unread-reporter/README.md`

- [ ] **Step 1: Write a failing packaging/workflow test**

Require the installed skill instructions and package scripts to include `npm run login` before the supervised dry scan.

- [ ] **Step 2: Verify the workflow test fails**

Run: `node test/plugin.test.js`

Expected: the new login-workflow assertion fails because the current skill starts with `npm run scan`.

- [ ] **Step 3: Update the setup instructions**

Describe the first-run sequence as configure, login bootstrap, dry scan, Slack test, then scheduling. State that the login window closes automatically after stable inbox readiness and that the scan subsequently reopens the saved profile.

- [ ] **Step 4: Validate the complete skill**

Run: `npm test`

Run: `python3 /Users/haydnqi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .`

Expected: all tests pass and the skill validator reports success.

### Task 4: Final regression check

**Files:**
- Verify only; do not modify unrelated deleted planning documents.

- [ ] **Step 1: Run static and full checks**

Run: `npm run check`

Expected: JavaScript syntax checks and all tests pass.

- [ ] **Step 2: Inspect the final diff**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only the navigation-safe login implementation and the two pre-existing deleted documents appear.

### Task 5: Consolidate post-blocker recovery ownership

**Files:**
- Modify: `linkedin-unread-reporter/test/browser.test.js`
- Modify: `linkedin-unread-reporter/test/scanner.test.js`
- Modify: `linkedin-unread-reporter/src/browser.js`
- Modify: `linkedin-unread-reporter/src/scanner.js`

- [x] **Step 1: Add failing deadline and feed-landing regressions**

Require recovery to reject a ready snapshot completed at the deadline and to re-enter the validated unread URL when a known blocker clears onto LinkedIn's feed.

- [x] **Step 2: Keep re-entry inside the original deadline**

Give the readiness adapter a one-shot blocker-cleared hook, pass the remaining deadline to `page.goto`, and retain the two consecutive ready checks after re-entry.

- [x] **Step 3: Remove duplicate scanner recovery navigation**

Require the scanner to navigate once initially and delegate blocker recovery, re-entry, and stable readiness to `adapter.waitForUnblocked`.

- [x] **Step 4: Re-run the complete browser-backed check**

Run: `npm run check`

Result: all syntax checks, browser fixtures, unit tests, packaging tests, and secret-safety tests pass.
