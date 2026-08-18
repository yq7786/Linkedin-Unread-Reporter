# Visible LinkedIn Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ignore hidden CAPTCHA/challenge DOM markers while retaining fail-closed handling for visible blockers and blocker URLs.

**Architecture:** Keep blocker URL classification in `linkedin-state.js` unchanged. Apply the existing page visibility predicate to DOM blocker candidates in the single recovery snapshot inside `browser.js`, with browser fixtures proving both sides of the boundary.

**Tech Stack:** Node.js 18+, Playwright 1.55.1, `node:test`.

---

### Task 1: Reproduce hidden and visible blocker behavior

**Files:**
- Modify: `linkedin-unread-reporter/test/browser-fixture.test.js`

- [ ] **Step 1: Add the hidden-CAPTCHA regression**

Create a ready inbox with a pressed Unread button, one visible conversation list, and two CAPTCHA matches hidden through `display:none` and the `hidden` attribute. Call `adapter.waitForUnblocked` with an injected clock and assert it returns `{ recovered: false }` without blocker notices.

- [ ] **Step 2: Add the visible-CAPTCHA safety regression**

Create the same ready inbox with a rendered positive-size `[data-test="captcha"]` element. Advance the injected clock to the deadline and assert `LinkedInBlockerError` with type `captcha`, plus one CAPTCHA notice.

- [ ] **Step 3: Run the browser fixture test in red state**

Run: `node test/browser-fixture.test.js`

Expected: the hidden-CAPTCHA regression fails because the current snapshot treats non-visible matches as blockers; the visible-CAPTCHA regression passes.

### Task 2: Filter DOM blocker candidates by visibility

**Files:**
- Modify: `linkedin-unread-reporter/src/browser.js`

- [ ] **Step 1: Implement the minimal visibility filter**

Replace each blocker `document.querySelector(selectorList)` truthiness check with `document.querySelectorAll(selectorList)` followed by `.some(isVisible)`. Do not change URL classification, readiness ordering, or scan invariants.

- [ ] **Step 2: Verify focused tests pass**

Run: `node test/browser-fixture.test.js`

Expected: hidden CAPTCHA markers are ignored and visible CAPTCHA markers still block.

- [ ] **Step 3: Verify the complete project**

Run: `npm run check`

Run: `python3 /Users/haydnqi/.codex/skills/.system/skill-creator/scripts/quick_validate.py linkedin-unread-reporter`

Expected: all syntax checks, tests, browser fixtures, and skill validation pass.
