# Node.js 18 Standalone Skill Design

## Goal

Make Node.js 18 the minimum supported runtime and distribute the complete reporter as a self-contained GitHub-installable Codex skill without a plugin or marketplace layer.

## Compatibility approach

Pin `playwright` to `1.55.1`, the newest selected project-compatible release whose published package metadata declares Node.js `>=18`. Change the application's own engine declaration to `>=18` and regenerate the lockfile so the root package and Playwright dependency agree. Do not merely relax the root engine while leaving the Node-20-only Playwright 1.62.1 dependency in place.

## Standalone skill packaging

Make the repository root the skill root. Place `SKILL.md`, `agents/openai.yaml`, and `references/automation-setup.md` at the repository root alongside the runnable Node application. Remove `.agents/plugins/marketplace.json`, the plugin manifest, and the `plugins/linkedin-unread-reporter` wrapper. The installed skill therefore includes `package.json`, `src/`, fixtures, tests, skill instructions, and scheduling guidance in one directory.

Team members share the GitHub repository URL with Codex and ask `$skill-installer` to install the repository root as `linkedin-unread-reporter`. Because the installer requires a repository path, the documented prompt explicitly identifies the root path and destination name. On the next turn, the teammate invokes `$linkedin-unread-reporter`; no separate application clone or plugin installation is required.

## Setup workflow

Update the README prerequisite from Node.js 20+ to Node.js 18+. In the root `linkedin-unread-reporter` skill, remove the first-live-scan User Agreement explanation/confirmation step and remove the preflight `npm test` step. The setup workflow begins by verifying Node.js 18+, installing dependencies, and installing Chromium when absent. Codex then opens a hidden local prompt for the teammate's Slack webhook, runs a supervised scan, asks for manual LinkedIn login or challenge completion when required, verifies Slack delivery, and creates the schedules. The remaining secure webhook, supervised scan, Slack-test approval, and real-report approval rules stay intact.

Keep the skill's safety invariants unchanged. Removing the setup explanation does not change the scanner's refusal to bypass login, CAPTCHA, checkpoints, or identity verification.

## Scheduling

After successful scan and Slack delivery verification, automatically create three active local Codex scheduled tasks for every teammate:

- Monday–Friday at 7:00am;
- Monday–Friday at 12:00pm;
- Monday–Friday at 4:00pm;
- IANA timezone `Australia/Adelaide`.

Do not ask each teammate for alternative times or a timezone. Keep the schedule anchored to Australia/Adelaide so daylight-saving transitions follow that named zone. Store no webhook, LinkedIn credential, browser cookie, contact name, or machine-specific path in an automation prompt.

Update this machine's three existing active automation prompts to accept Node.js 18 or newer so scheduled behavior matches the project requirement. Preserve their weekday times, Australia/Adelaide behavior, project target, active status, model, reasoning effort, and failure-only notification policy.

## Validation

Run the full test suite with the machine's Node.js 18 runtime, validate the root skill, verify the lockfile declares Node.js 18 at the project root, and scan committed project text for stale Node-20 setup language, plugin manifests, marketplace entries, and the removed setup gates. Test the root skill with the GitHub installer helper against a local temporary destination before publishing instructions.

## Worktree preservation

Preserve the user's existing uncommitted README edits and deleted prior design/plan documents. Modify only the overlapping README prerequisite line and do not restore or overwrite the user's other changes.
