# Visible LinkedIn Blockers Design

## Goal

Prevent hidden CAPTCHA or challenge markup on LinkedIn's ready unread inbox from trapping the reporter in manual recovery, without weakening handling of visible verification or URL-based login/checkpoint pages.

## Detection boundary

The Playwright page snapshot continues to classify login, checkpoint, and challenge URLs exactly as it does now. DOM CAPTCHA and challenge selectors contribute blocker text only when at least one matching element passes the reporter's existing rendered-visibility check: computed `display` is not `none`, computed `visibility` is not `hidden`, and its bounding rectangle has positive width and height.

If a visible blocker and a ready unread inbox coexist, the blocker still wins because `classifyBlocker` runs before readiness is accepted. Hidden blocker elements are ignored. Conversation rows, names, previews, Slack behavior, profile persistence, and scheduling remain unchanged.

## Verification

A sanitized Playwright fixture will cover a ready unread inbox containing two invisible CAPTCHA matches and assert stable readiness succeeds without a blocker notice. A second fixture will make a CAPTCHA match visible and assert the reporter remains blocked. Existing state tests retain URL-based checkpoint coverage, and the complete browser-backed suite must pass.
