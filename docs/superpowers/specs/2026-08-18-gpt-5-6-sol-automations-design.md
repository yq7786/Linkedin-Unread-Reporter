# GPT-5.6 Sol Automation Configuration Design

## Goal

Every future LinkedIn unread reporter installation creates or updates its three fixed weekday automations with model `gpt-5.6-sol` and reasoning effort `medium` instead of inheriting GPT-5.4 or the current task defaults.

## Scope

The automation reference will require these two fields explicitly for all three local recurring tasks. The 7:00am, 12:00pm, and 4:00pm weekday schedules, `Australia/Adelaide` timezone, active status, local execution, prompt, credentials policy, project target, and no-backfill behavior remain unchanged. Verification must inspect all three tasks and confirm the exact model and reasoning effort.

No existing automation is modified in this change; the rule applies when the installed skill next creates or updates the schedules.
