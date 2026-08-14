# LinkedIn Unread Reporter Design

**Date:** 2026-08-14  
**Status:** Approved for implementation
**Local target:** A user-selected clone directory; the path is never committed
**Distribution:** Public GitHub-ready repository and repo-scoped Codex plugin marketplace

## Goal

Build a local, read-only LinkedIn inbox reporter that visits LinkedIn's filtered unread-message page at 7:00am, 12:00pm, and 4:00pm every weekday in the `Australia/Adelaide` timezone, then posts the unread conversation count and displayed contact names to Slack.

Package the reporter so other people can clone the repository, install its bundled Codex plugin, configure their own local LinkedIn session and Slack webhook, and create scheduled reports in their own timezone. No machine-specific path or account data is committed.

The user accepts that automated browser access may violate LinkedIn's User Agreement and may expose the account to checkpoints or restrictions. The implementation minimizes activity but cannot remove that platform-policy risk.

## Scope

Version one covers the personal LinkedIn inbox. It includes ordinary one-to-one conversations, genuine InMail, and group conversations that LinkedIn displays in the unread-filtered conversation list. It excludes sponsored or automated conversations.

The reporter reads only conversation-list rows. It must not open a conversation, mark a message read, send a message, inspect message bodies beyond the row preview needed to identify sponsored content, or mutate LinkedIn state.

## Confirmed LinkedIn UI Behavior

A supervised check on 2026-08-14 established that navigating directly to:

```text
https://www.linkedin.com/messaging/?filter=unread
```

selects LinkedIn's Unread filter without opening a conversation. The verified page had:

- the Unread button in its pressed state;
- zero active conversation rows;
- no conversation-detail pane;
- only rows carrying LinkedIn's unread class or unread accessibility badge; and
- no change to the unread state during inspection.

Conversation rows were clickable elements without ordinary thread links. The reporter therefore cannot provide a direct per-contact thread URL without opening conversations. Slack will include one shared link to the filtered unread inbox instead.

## Architecture

The project is a small Node.js application using Playwright and Node's built-in test runner. It is separate from `linkedin-lead-enrichment`; it reuses that project's proven patterns for `.env` loading, a persistent headed Chromium profile, login detection, and LinkedIn checkpoint detection. It does not depend on Neon, the OpenAI API, or the lead-enrichment portal.

The repository also exposes a repo-scoped Codex plugin. The plugin bundles one concise `linkedin-unread-reporter` skill that teaches Codex how to install dependencies, collect local configuration, perform supervised login and verification, run reports, diagnose failures, and create or update that user's scheduled tasks. It does not bundle an MCP server, browser extension, lifecycle hook, or credentials.

The implementation is divided into focused modules:

1. **Configuration** — loads and validates the Slack webhook, persistent browser-profile path, scan cap, LinkedIn URL, and authentication timeout.
2. **Browser session** — launches one headed persistent Chromium context and closes it after success or terminal failure.
3. **LinkedIn blocker handling** — recognizes login, authwall, CAPTCHA, checkpoint, and challenge states; keeps the visible browser open for manual recovery.
4. **Unread-page scanner** — navigates directly to the filtered URL, verifies that the Unread filter is active, extracts eligible list rows, and scrolls or activates `Load more` when necessary.
5. **Report formatter** — groups exact duplicate display names while preserving a count based on conversation rows.
6. **Slack publisher** — posts a sanitized JSON payload through the webhook and never logs the secret.
7. **CLI** — exposes configuration, scan, Slack-test, and scheduled-report entry points with meaningful exit codes.

## Portable Repository Layout

The public repository uses this structure:

```text
linkedin-unread-reporter/
├── .agents/plugins/marketplace.json
├── .gitignore
├── README.md
├── package.json
├── src/
├── test/
├── fixtures/
├── docs/superpowers/
└── plugins/linkedin-unread-reporter/
    ├── .codex-plugin/plugin.json
    └── skills/linkedin-unread-reporter/
        ├── SKILL.md
        ├── agents/openai.yaml
        └── references/automation-setup.md
```

The root is the executable Node.js project. The plugin contains procedural Codex guidance only and operates on the current repository clone. The skill must detect the repository by checking for the expected `package.json`, `src/`, and `.env.example`; if the user installed the plugin without cloning the application, it instructs them to clone the repository rather than inventing a path.

The repo marketplace entry points to `./plugins/linkedin-unread-reporter` and uses installation policy `AVAILABLE`, authentication policy `ON_INSTALL`, and category `Productivity`. The plugin has a stable kebab-case identity, semantic version, manifest, UI metadata, and MIT license metadata. The plugin and skill are validated with the official scaffold validators before release.

The README is for human installation and security disclosure. Detailed agent procedures remain inside the skill and its single automation reference so human and agent documentation do not drift.

## Installation and Sharing

A new user follows this flow:

1. Clone the public GitHub repository.
2. Add the repository as a Codex plugin marketplace source, using the GitHub owner/repository reference or repository URL supported by Codex.
3. Install and enable `linkedin-unread-reporter` from that marketplace.
4. Open the cloned repository as a trusted local Codex project.
5. Ask the bundled skill to set up LinkedIn unread reporting.
6. Let the skill install pinned Node dependencies, collect the user's Slack webhook locally, open the persistent browser for manual LinkedIn login, run tests, and perform a supervised dry scan.
7. Ask the skill to create the desired local scheduled tasks.

This packaging follows official Codex plugin structure: a `.codex-plugin/plugin.json` manifest, skills under `skills/`, and a repo marketplace at `.agents/plugins/marketplace.json`. The repository is GitHub-ready but is not published to GitHub, a workspace, or the universal Plugins Directory without a separate explicit request.

## Configuration and Secrets

The application stores configuration in a gitignored `.env` file. It never stores a LinkedIn username or password. LinkedIn authentication exists only in the persistent Playwright browser profile.

If `SLACK_WEBHOOK_URL` is missing during an interactive terminal run, the CLI asks for the rotated webhook locally and saves it to `.env` with restrictive file permissions. It must not echo the value, put it in command history, include it in Codex automation prompts, or print it in logs. A non-interactive scheduled run must fail with a configuration instruction instead of waiting for input. The previously exposed webhook has been revoked and replaced.

Expected configuration:

```text
SLACK_WEBHOOK_URL=<rotated incoming-webhook URL>
LINKEDIN_BROWSER_PROFILE_PATH=.linkedin-browser-profile
LINKEDIN_UNREAD_URL=https://www.linkedin.com/messaging/?filter=unread
MAX_UNREAD_CONVERSATIONS=50
LINKEDIN_AUTH_TIMEOUT_MS=900000
REPORT_TIMEZONE=Australia/Adelaide
```

All paths in committed configuration and documentation are relative or discovered from the current clone. The user's `.env` and `.linkedin-browser-profile/` remain local and gitignored. Each installation supplies its own webhook, browser profile, report timezone, schedule, and LinkedIn login.

## Scan Algorithm

For each run:

1. Launch the persistent browser context in headed mode.
2. Navigate directly to `https://www.linkedin.com/messaging/?filter=unread`.
3. Detect login, authwall, checkpoint, challenge, or CAPTCHA states.
4. If blocked, keep the browser visible, tell the user through the Codex task result which manual action is required, and poll for up to 15 minutes.
5. Continue automatically if the blocker clears. Otherwise close the context, fail the run, and do not send a misleading Slack report.
6. Verify that the Unread filter button is pressed, no conversation row is active, and no conversation-detail pane is present. Fail closed if any invariant is false.
7. Read conversation rows from the list. A row qualifies only when it has LinkedIn's explicit unread class or unread accessibility badge and does not carry an explicit Sponsored or automated-conversation label. The scanner does not infer automation from message text.
8. Extract the displayed conversation name only. Do not retain or report message previews.
9. Scroll the list and use a visible `Load more conversations` control when present. Continue until no new rows appear and no load-more control remains, or until 50 qualifying rows have been collected.
10. Report truncation only when scanning stops because the 50-row cap was reached before list stability. A complete list containing exactly 50 rows is not labeled truncated.
11. Format and send the Slack report.
12. Close the browser context.

The scanner keeps no database and no pending-contact file. Each scheduled run reflects LinkedIn's current unread-filtered list.

## Counting and Duplicate Names

The total is the number of qualifying unread conversation rows after sponsored rows are excluded. It is not the number of unique display names.

For presentation, exact duplicate names are grouped:

```text
Alex Smith — 2 conversations
```

The total still counts both rows. The application must not merge near-matching names or assume that equal names identify the same LinkedIn member.

## Slack Output

The report contains no message previews, profile details, or locally persisted contact data. Its format is:

```text
LinkedIn unread message: 3
Scanned: 12:00pm Australia/Adelaide

• Contact name
• Contact name
• Contact name

Open LinkedIn Unread Inbox
```

`Open LinkedIn Unread Inbox` links to `https://www.linkedin.com/messaging/?filter=unread`. For zero results, the reporter still sends `LinkedIn unread message: 0`. When capped, the heading indicates `50+` or adds a clear truncation notice.

Each scheduled execution sends a new Slack message. Outstanding unread conversations therefore repeat in later reports until they are read in LinkedIn.

## Scheduling

Create three active local Codex cron automations against this project:

- 7:00am every Monday through Friday;
- 12:00pm every Monday through Friday; and
- 4:00pm every Monday through Friday.

For the initial user, schedules use the Adelaide locale so daylight-saving changes follow `Australia/Adelaide`. The Mac must be awake, signed in, and able to show the headed browser. Missed executions are not backfilled; the next scheduled run performs the next scan.

For shared installations, the bundled skill asks the user for their desired times, weekdays, and IANA timezone. It then creates equivalent local Codex schedules against that user's clone. It never copies the original user's Adelaide schedule unless requested.

The automation prompt invokes the same scheduled-report CLI entry point. It contains no webhook or LinkedIn credential.

The automation reference explains the intended scheduling behavior and required local execution environment but does not store a user's generated automation identifiers. Codex uses its scheduling capability to create or update the actual tasks on each installation.

## Failure Behavior

- **Login/CAPTCHA/checkpoint:** keep the visible browser open, explain the required manual action in the Codex task, wait up to 15 minutes, resume if cleared, otherwise fail.
- **Unread invariant violation:** fail closed without clicking a conversation or sending Slack.
- **LinkedIn selector drift:** fail with a sanitized diagnostic that names the missing invariant but excludes contact names and previews.
- **Slack rejection or network failure:** fail with the HTTP status category and sanitized error; never include the webhook URL.
- **Scan cap reached:** send a successful but explicitly truncated report.
- **Zero unread:** send a successful zero-count report.

Logs contain timestamps, counts, stages, and sanitized errors only. They exclude names, previews, webhook values, cookies, browser-profile contents, and LinkedIn thread identifiers.

## Testing Strategy

Development follows test-driven development with Node's built-in test runner.

Automated tests cover:

- configuration parsing and webhook validation without exposing the value;
- login, authwall, checkpoint, challenge, and CAPTCHA detection;
- eligibility rules for unread, sponsored, malformed, and duplicate-name rows;
- grouping duplicate names while retaining conversation-row totals;
- scanning until stable, using load-more, and stopping at 50;
- invariant failures when a conversation becomes active or a detail pane appears;
- exact Slack formatting for zero, normal, duplicate, and capped results;
- sanitized Slack HTTP failures; and
- CLI exit behavior.
- plugin manifest, marketplace entry, skill metadata, and the absence of machine-specific paths or secret-shaped values in committed files.

Browser-facing extraction uses saved HTML fixtures for deterministic tests. A supervised live verification then confirms the selectors against the current LinkedIn page without opening a conversation or changing the unread count.

An explicit Slack-test command sends one clearly labeled test message only after the rotated webhook has been collected locally. Test delivery is not performed implicitly during configuration.

## Acceptance Criteria

Version one is complete when:

1. All automated tests pass without warnings.
2. A supervised live scan reaches the direct unread URL, leaves every conversation unopened, preserves the unread count, and returns only eligible names.
3. Logs contain no names, previews, secrets, cookies, or thread identifiers.
4. A deliberate Slack test succeeds through the rotated webhook.
5. A zero-result fixture sends the expected zero-count payload.
6. The three weekday Adelaide Codex automations are active and invoke the same tested entry point.
7. The project runs from the user's selected clone directory with the `.env` and persistent browser profile excluded from git.
8. A clean clone can install the repo marketplace plugin, trigger the bundled skill, and reach supervised configuration without relying on the original machine.
9. The repository contains no webhook, LinkedIn cookie, browser-profile data, account identifier, contact name, or absolute user-home path.

## Non-Goals

- Reading or replying to LinkedIn messages.
- Determining whether read conversations still await a response.
- Providing direct per-conversation links when LinkedIn does not expose them in list rows.
- Using LinkedIn private APIs, scraping profile data, or bypassing security controls.
- Hosting LinkedIn credentials or browser state in the cloud.
- Persisting names, message contents, or a contact queue locally.
- Automatically publishing the repository, plugin, or marketplace to GitHub, a ChatGPT workspace, or the universal Plugins Directory.
