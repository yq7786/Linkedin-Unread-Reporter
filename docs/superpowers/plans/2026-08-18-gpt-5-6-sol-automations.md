# GPT-5.6 Sol Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require GPT-5.6 Sol with medium reasoning for all three fixed LinkedIn reporter automations.

**Architecture:** Keep model selection in the conditional automation reference rather than the top-level skill entrypoint. Extend the existing packaging test so an installed copy cannot omit or silently change either automation field.

**Tech Stack:** Markdown skill references and Node.js `node:test` packaging assertions.

---

### Task 1: Lock the automation model contract

**Files:**
- Modify: `linkedin-unread-reporter/test/plugin.test.js`
- Modify: `linkedin-unread-reporter/references/automation-setup.md`

- [ ] **Step 1: Write the failing packaging assertions**

Assert that the automation reference contains the exact model identifier `gpt-5.6-sol`, the exact reasoning effort `medium`, and no `gpt-5.4` reference.

- [ ] **Step 2: Verify the test fails**

Run: `node test/plugin.test.js`

Expected: the model assertion fails because the current reference does not specify a model.

- [ ] **Step 3: Add the required automation fields**

Require every create or update call to set `model` to `gpt-5.6-sol` and `reasoningEffort` to `medium`. Add both fields to the post-creation verification checklist without changing recurrence, timezone, prompt, status, or execution location.

- [ ] **Step 4: Verify the skill**

Run: `node test/plugin.test.js`

Run: `npm run check`

Run: `python3 /Users/haydnqi/.codex/skills/.system/skill-creator/scripts/quick_validate.py linkedin-unread-reporter`

Expected: the packaging test, complete test suite, and skill validator all pass.
