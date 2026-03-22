# Feishu Pairing UX Implementation

## Goal

Let `OpenClaw Desktop` approve Feishu DM access without relying on a globally installed `openclaw` CLI and without making end users manually look up `open_id` before first use.

## User Entry Points

The Desktop shell now exposes Feishu access management in three places:

1. `Settings -> Feishu Settings`
2. `Dashboard -> Feishu Settings`
3. Tray menu: `Feishu Settings`

The setup wizard also warns users about the next step on the completion screen:

- send a Feishu DM to the bot
- then open `Settings > Feishu Settings`

## Product Behavior

### Pending requests

The Feishu access manager shows pending DM pairing requests created by OpenClaw's default `dmPolicy: "pairing"` flow.

Desktop also repairs older configs that forgot to persist `channels.feishu.dmPolicy` and would otherwise fall back to upstream defaults. `Feishu Settings` surfaces the current DM mode (`pairing`, `open`, `allowlist`, `disabled`) and offers a one-click fix back to `pairing` when approvals are being bypassed.

Desktop reads pending rows from any of these (merged, de-duplicated by code):

- `~/.openclaw/credentials/feishu-default-pairing.json` (default account; most common)
- `~/.openclaw/credentials/feishu-pairing.json` (legacy / single-file)
- `~/.openclaw/credentials/feishu-<accountId>-pairing.json` (multi-account)

If the list is empty but the bot already sent a pairing code in Feishu, use **Approve using the code from Feishu** on the same screen — approval runs `pairing approve feishu <CODE>` and does not depend on the list being populated.

Displayed data:

- pairing code
- sender `open_id` when available
- sender display name when available
- request and expiry timestamps when available

### Approved users

Desktop shows and edits the local approved sender store:

- `~/.openclaw/credentials/feishu-default-allowFrom.json`

Supported actions:

- approve a pending request
- view approved `open_id` entries
- remove approved users
- manually add an `open_id`

## Runtime Strategy

Desktop keeps the actual approval action aligned with upstream OpenClaw by calling the bundled runtime:

- `resources/node/node.exe`
- `resources/openclaw/openclaw.mjs pairing approve feishu <CODE>`

This avoids:

- global CLI version mismatches
- missing PATH issues
- missing plugin dependencies in an old global install

## Desktop Scope

Implemented scope is intentionally centered on the desktop shell:

- dedicated `FeishuAccessView`
- new pairing IPC bridge
- local credentials file access for pending + approved lists
- tray and settings entry points

## Delivery Phases

### Phase 1: Implemented in this repository

- Feishu access view inside Desktop
- Settings entry
- Dashboard quick action
- tray menu shortcut
- pending pairing list
- approve pending pairing code
- approved sender list
- remove approved sender
- manual add by `open_id`

### Phase 2: Natural follow-up improvements

- pending count badge in shell UI
- friendlier sender metadata if upstream pairing store exposes more fields
- batch actions for allowlist management

### Phase 3: Optional desktop polish

- toast when a new pending request appears
- diagnostics hint when Feishu is configured but all inbound users are still blocked by pairing
- deeper status checks for Feishu app publish / permission issues

## Known Limitation

Upstream pairing CLI documents `list` and `approve`, but not `reject`.

Current Desktop implementation therefore exposes:

- `Approve` for pending requests
- `Remove` for already approved users

It does not show a fake `Reject` button that the bundled runtime cannot actually execute.
