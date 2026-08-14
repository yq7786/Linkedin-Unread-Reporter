# Node.js 18 and Plugin Workflow Design

## Goal

Make Node.js 18 the minimum supported runtime while keeping installation functional and simplifying the bundled plugin's setup workflow exactly as requested.

## Compatibility approach

Pin `playwright` to `1.55.1`, the newest selected project-compatible release whose published package metadata declares Node.js `>=18`. Change the application's own engine declaration to `>=18` and regenerate the lockfile so the root package and Playwright dependency agree. Do not merely relax the root engine while leaving the Node-20-only Playwright 1.62.1 dependency in place.

## Documentation and plugin workflow

Update the README prerequisite from Node.js 20+ to Node.js 18+. In the bundled `linkedin-unread-reporter` skill, remove the first-live-scan User Agreement explanation/confirmation step and remove the preflight `npm test` step. The setup workflow begins by verifying Node.js 18+, installing dependencies, and installing Chromium when absent; the remaining secure webhook, supervised scan, Slack-test approval, and real-report approval steps stay intact and are renumbered.

Keep the skill's safety invariants unchanged. Removing the setup explanation does not change the scanner's refusal to bypass login, CAPTCHA, checkpoints, or identity verification.

## Existing automations

Update the three active local automation prompts to accept Node.js 18 or newer so scheduled behavior matches the project requirement. Preserve their weekday times, Australia/Adelaide local-time behavior, project target, active status, model, reasoning effort, and failure-only notification policy.

## Validation

Run the full test suite with the machine's Node.js 18 runtime, validate the skill and plugin manifests, verify the lockfile declares Node.js 18 at the project root, and scan committed project text for stale Node-20 setup language. Refresh the local plugin cachebuster using the plugin update helper and reinstall it from the existing repo marketplace if the local Codex CLI supports that configured marketplace.

## Worktree preservation

Preserve the user's existing uncommitted README edits and deleted prior design/plan documents. Modify only the overlapping README prerequisite line and do not restore or overwrite the user's other changes.
