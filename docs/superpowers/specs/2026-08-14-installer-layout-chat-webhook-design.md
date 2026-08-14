# Installer-safe layout and chat webhook design

## Problem

The standalone reporter currently lives at repository root and is installed with `--path .`. Codex's supported Git fallback uses cone-mode sparse checkout. Selecting `.` in that mode checks out top-level files but omits required directories such as `src/`, `fixtures/`, `test/`, and `references/`. The partial copy still contains `package.json`, so dependency installation can succeed before the missing runtime is discovered.

Some machines also fail the installer's direct-download path because their local Python trust store cannot validate GitHub's certificate chain. TLS verification must remain enabled.

The setup workflow currently asks the user to paste the Slack webhook into a hidden terminal prompt. The user has explicitly approved collecting the webhook in Codex chat instead, accepting that it remains in chat history.

## Repository layout

Move the complete installable artifact into a named `linkedin-unread-reporter/` directory. Keep repository-facing documentation and design records at repository root. The named directory contains every file required at runtime:

- `SKILL.md` and `agents/openai.yaml`;
- `package.json` and `package-lock.json`;
- `.env.example` and a local `.gitignore`;
- `src/`, `fixtures/`, `references/`, and `test/`;
- the applicable license file.

Use the named path for installation:

```text
Use $skill-installer to install yq7786/Linkedin-Unread-Reporter with --path linkedin-unread-reporter.
```

The path basename already matches the skill name, so `--name` is unnecessary. Both direct download and Git sparse checkout must produce the same complete artifact.

## Installation verification

Before running `npm install`, require and validate all installation markers: `SKILL.md`, package name `linkedin-unread-reporter`, `src/cli.js`, `.env.example`, and `references/automation-setup.md`. If any marker is missing, stop immediately and tell the user to remove the incomplete destination and reinstall using the named path. Do not attempt dependency installation, browser installation, configuration, scanning, Slack delivery, or scheduling from a partial copy.

If direct download fails because of a certificate-chain error, retry with the installer's supported `--method git` option and the same named path. Do not disable TLS verification, change global certificate settings, or use an unverified download.

## Chat webhook flow

When `SLACK_WEBHOOK_URL` is not configured, ask exactly:

> Please provide `SLACK_WEBHOOK_URL`.

Treat the response as a secret even though the user has accepted its presence in chat history. Do not quote, summarize, validate visibly, or repeat it. Start `npm run configure` in an interactive PTY and submit the supplied value through the configurator's hidden input. Never place the value in a shell command, command-line argument, environment assignment, patch, log, automation prompt, or task output. Do not read `.env` back after writing it; verify only that configuration succeeded and the file permissions are `0600`.

The existing configurator remains the single writer for `.env`, retaining validation, atomic replacement, private permissions, cleanup on failure, and error redaction. The webhook must never be passed to a scheduled task. Each teammate supplies their own current webhook.

## Reporter behavior

Keep scanning, privacy, Slack formatting, manual LinkedIn login and challenge handling, and fail-closed selector rules unchanged. After a supervised scan and approved Slack test succeed, create the same three active weekday schedules at 7:00am, 12:00pm, and 4:00pm in `Australia/Adelaide`.

## Local migration

Do not read, copy into source control, or expose an existing `.env` or persistent browser profile. Repository restructuring affects the published source layout only. Existing globally installed copies and their local authentication state continue to operate until deliberately reinstalled. Existing local automations continue to invoke the globally installed skill.

## Verification

Add regression coverage for:

1. the documented installer path being `linkedin-unread-reporter`, never `.`;
2. a Git sparse checkout of the named path containing every required runtime directory and marker;
3. installation verification occurring before dependency setup instructions;
4. the skill asking for `SLACK_WEBHOOK_URL` in chat and transferring it only through hidden PTY input;
5. instructions forbidding webhook use in commands, arguments, environment assignments, patches, logs, and automations;
6. the fixed Adelaide schedules remaining unchanged.

Run the complete Node.js 18 test suite, validate the nested skill with the skill validator, perform clean temporary installs through both the normal archive boundary and Git sparse checkout, and scan committed content for webhook-shaped secrets and machine-specific paths.
