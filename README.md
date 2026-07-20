# Keeper Google Chat Integration

Self-hosted Google Chat app for Keeper Security. Zero-knowledge encryption is preserved by running the listener on **customer infrastructure** and talking to **Keeper Commander Service Mode** over a local REST API.

This Node.js project mirrors the Keeper Slack App model, using **Google Cloud Pub/Sub** (outbound pull) so no public inbound endpoint is required.

## Overview

- Request access to Keeper records with approval workflows (`/keeper-request-record`)
- Approvers grant or deny access from a dedicated Google Chat space
- Requesters receive DMs with the result
- Optional mock mode for UI testing without a live Commander

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
- Keeper Commander (optional if `mock_mode: true`)

## Quick start

```bash
cd ~/Desktop/Keeper-google-chat-integration
cp config.example.yaml config.yaml   # already created if you followed setup
cp .env.example .env
# Place service-account.json in the project root
npm install
npm run test:local                   # offline end-to-end (no GCP)
npm start                            # live Pub/Sub listener
```

### Live test

```text
/keeper-request-record kR3cF9Xm2Lp8NqT1uV6w Need access for deployment
```

## Configuration

| Item | Source | Purpose |
|------|--------|---------|
| `GOOGLE_PROJECT_ID` | `.env` / `config.yaml` | GCP project |
| `GOOGLE_SUBSCRIPTION_ID` | `.env` / `config.yaml` | Pub/Sub pull subscription |
| `GOOGLE_APPLICATION_CREDENTIALS` | `.env` | Path to `service-account.json` |
| `CHAT_APPROVALS_SPACE_ID` | `.env` / `config.yaml` | Approvals space (`spaces/...`) |
| `KEEPER_MOCK_MODE` | `.env` / `config.yaml` | Skip live Commander |
| `KEEPER_SERVICE_URL` / `KEEPER_API_KEY` | `.env` / `config.yaml` | Commander Service Mode |

## Docker

```bash
docker compose up -d --build
docker compose logs -f
```

Mount `config.yaml` and `service-account.json` (see `docker-compose.yml`).

## Project layout

```text
src/index.js                 # Pub/Sub listener entrypoint
src/app.js                   # Event normalize + router
src/handlers/request_record.js
src/handlers/approvals.js
src/lib/chat_client.js
src/lib/keeper_client.js
src/lib/cards.js
scripts/test_local_flow.js
scripts/diagnose_chat_pubsub.js
config.example.yaml
.env.example
```

## Security note

Never commit `service-account.json`, `.env`, or `config.yaml` with live secrets. Rotate any key that was shared in chat or committed by mistake.

## License

Copyright Keeper Security Inc.
Contact: commander@keepersecurity.com
