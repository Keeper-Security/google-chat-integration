# Keeper Google Chat Integration

Self-hosted Google Chat app for Keeper Security. Zero-knowledge encryption is preserved by running the listener on **customer infrastructure** and talking to **Keeper Commander Service Mode** over a local REST API.

This Node.js project uses **Google Cloud Pub/Sub** (outbound pull) so no public inbound endpoint is required.

## Overview

- Request access to Keeper records with approval workflows (`/keeper-request-record`)
- Request folder access (`/keeper-request-folder`) and external shares (`/keeper-external-share`)
- Create secrets directly in shared folders (`/keeper-create-secret` — bot DM or a space only; not peer DMs)
- Approvers grant or deny access from a dedicated Google Chat space
- Optional **EPM** privilege-elevation approvals (background poll → Approve/Deny in the approvals space)
- Optional **Cloud SSO device** approvals (background poll → Approve Device / Deny Device)
- Requesters receive DMs with the result

```text
[ Google Chat ] --> [ Pub/Sub topic ] <-- pull -- [ This app (Node/Docker) ]
                                                      |
                                                      v
                                            [ Keeper Commander Service Mode ]
```

## Prerequisites

- Node.js 18+
- Google Workspace + GCP project (Chat API + Pub/Sub enabled)
- `service-account.json` for the worker service account
- Keeper Commander Service Mode

## Quick start

```bash
git clone https://github.com/Keeper-Security/google-chat-integration.git
cd google-chat-integration
cp config.example.yaml config.yaml
# Edit config.yaml, then place service-account.json in the project root
npm install
npm run test:local                   # offline end-to-end (no GCP)
npm start                            # live Pub/Sub listener
```

### Live test

```text
/keeper-request-record kR3cF9Xm2Lp8NqT1uV6w Need access for deployment
```

## Configuration

### Local development

Settings live in `config.yaml` (copy from `config.example.yaml`). Place `service-account.json` next to it.

| Key | Purpose |
|-----|---------|
| `google.project_id` | GCP project |
| `google.subscription_id` | Pub/Sub pull subscription |
| `google.credentials_file` | Path to `service-account.json` |
| `chat.approvals_space_id` | Approvals space (`spaces/...`) |
| `keeper.service_url` / `keeper.api_key` | Commander Service Mode |
| `epm.enabled` | Poll for EPM elevation approvals |
| `epm.polling_interval_in_sec` | EPM poll interval (default 120) |
| `device_approval.enabled` | Poll for Cloud SSO device approvals |
| `device_approval.polling_interval_in_sec` | Device poll interval (default 120) |

### Production (KSM)

When `KSM_CONFIG` is set, credentials are loaded from Keeper Secrets Manager. KSM overlays any local YAML.

| Env | Purpose |
|-----|---------|
| `KSM_CONFIG` | Base64 KSM client config JSON, or path to `ksm-config.json` |
| `COMMANDER_RECORD` | UID or title for Service Mode record (default `CSMD config`) |
| `GCHAT_RECORD` | UID or title for Google Chat record (default `CSMD google chat config`) |

**COMMANDER_RECORD** fields: `service_url`, `api_key`

**GCHAT_RECORD** fields:

| Vault field | Maps to |
|-------------|---------|
| `google_service_account_json` | Temp SA file for Chat + Pub/Sub |
| `google_project_id` | `google.project_id` |
| `google_subscription_id` | `google.subscription_id` |
| `google_topic_id` | `google.topic_id` |
| `chat_approval_space_id` | `chat.approvals_space_id` |
| `chat_command_request_record_id` | slash command id |
| `chat_command_request_folder_id` | slash command id |
| `chat_command_external_share_id` | slash command id (`/keeper-external-share`) |
| `pedm_enabled` | `epm.enabled` |
| `pedm_polling_interval` | `epm.polling_interval_in_sec` |
| `device_approval_enabled` | `device_approval.enabled` |
| `device_approval_polling_interval` | `device_approval.polling_interval_in_sec` |

Optional notes JSON on either record can override the same keys.

## EPM approvals

When `epm.enabled` is true, the app polls Keeper Commander (`epm sync-down` + `epm approval list --type pending`) and posts new elevation requests to the approvals space. Approvers use **Approve** / **Deny** on the card (`epm approval action --approve|--deny`). Already-processed requests show a clear status. Commander Service Mode must allowlist the `epm` commands.

```yaml
epm:
  enabled: true
  polling_interval_in_sec: 120
```

## Cloud SSO device approvals

When `device_approval.enabled` is true, the app polls Keeper Commander (`device-approve --reload --format=json`) and posts new device registration requests to the approvals space. Approvers use **Approve Device** / **Deny Device** (`device-approve --approve|--deny`). Already-processed devices show a clear status. Commander Service Mode must allowlist the `device-approve` command.

```yaml
device_approval:
  enabled: true
  polling_interval_in_sec: 120
```

## Docker

The published image is `keeper/gchat-app`, built for `linux/amd64` and `linux/arm64`.

For production, Keeper Commander's `gchat-app-setup` command generates a `docker-compose.yml`
containing both Commander Service Mode and this app, configured through Keeper Secrets Manager.
See [setup.md](setup.md).

For local development:

```bash
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml logs -f
```

This mounts `config.yaml` and `service-account.json` into the container. When running in a
container, `localhost` in `keeper.service_url` is rewritten to the Commander service name
(`commander-gchat` by default); set `COMMANDER_HOST` to override it.

The release process is documented in [RELEASING.md](RELEASING.md).

## Project layout

```text
src/index.js                 # Pub/Sub listener entrypoint
src/app.js                   # Event normalize + router
src/handlers/                # Slash command + card handlers
src/handlers/approvals/      # Approval card click actions
src/background/              # EPM + device approval pollers
src/lib/cards/               # Google Chat card builders
src/lib/keeper/              # Commander client (client, search, grants, create, epm, device)
src/lib/chat_client.js
scripts/test_local_flow.js
scripts/diagnose_chat_pubsub.js
config.example.yaml
```

## Security note

Never commit `service-account.json` or `config.yaml` with live secrets. Rotate any key that was shared in chat or committed by mistake.

## License

Copyright Keeper Security Inc.
Contact: commander@keepersecurity.com
