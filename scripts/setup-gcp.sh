#!/usr/bin/env bash
#
# Automated GCP setup for the Keeper Google Chat integration.
#
# This script automates ALL of the Google Cloud infrastructure:
#   - project selection/creation
#   - enabling the Chat + Pub/Sub APIs
#   - creating the Pub/Sub topic + pull subscription
#   - creating the worker service account + downloading its key
#   - granting the two required IAM bindings
#   - generating config.yaml
#
# It CANNOT automate the Google Chat API "Configuration" tab (app name,
# slash command, Pub/Sub connection, visibility). Google provides no API or
# manifest for that step — unlike Slack's app manifest. Those manual steps are
# printed at the end and documented in SETUP-AUTOMATION.md.
#
# Usage:
#   PROJECT_ID=my-project BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX \
#     ./scripts/setup-gcp.sh
#
# Prerequisites:
#   - gcloud CLI installed and authenticated: `gcloud auth login`
#   - Permission to create/edit the target project (Owner or Editor)
#
set -euo pipefail

# ----------------------------- Configuration -----------------------------
# Override any of these via environment variables before running.
PROJECT_ID="${PROJECT_ID:-keeper-gchat-$(date +%s)}"
PROJECT_NAME="${PROJECT_NAME:-Keeper Google Chat}"
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"        # optional: XXXXXX-XXXXXX-XXXXXX
TOPIC_ID="${TOPIC_ID:-keeper-chat-events}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-keeper-chat-events-sub}"
SA_NAME="${SA_NAME:-keeper-chat-worker}"
SA_KEY_FILE="${SA_KEY_FILE:-./service-account.json}"
APP_NAME="${APP_NAME:-Keeper Security}"
COMMAND_ID="${COMMAND_ID:-1}"
SLASH_COMMAND="${SLASH_COMMAND:-/keeper-request-record}"

# Google Chat's fixed system account that publishes events to your topic
# for a standalone (non-add-on) Chat app.
CHAT_PUSH_SA="chat-api-push@system.gserviceaccount.com"
# --------------------------------------------------------------------------

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[warn]\033[0m %s\n' "$*"; }

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI not found. Install it: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

log "Using project: ${PROJECT_ID}"

# 1. Create (or reuse) the project
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  log "Project already exists — reusing it."
else
  log "Creating project ${PROJECT_ID}..."
  gcloud projects create "${PROJECT_ID}" --name="${PROJECT_NAME}"
fi
gcloud config set project "${PROJECT_ID}"

# 2. Link billing (required before APIs can be enabled)
if [[ -n "${BILLING_ACCOUNT_ID}" ]]; then
  log "Linking billing account ${BILLING_ACCOUNT_ID}..."
  gcloud billing projects link "${PROJECT_ID}" \
    --billing-account="${BILLING_ACCOUNT_ID}"
else
  warn "BILLING_ACCOUNT_ID not set. If APIs fail to enable, link billing in the console then re-run."
fi

# 3. Enable required APIs
log "Enabling Chat, Pub/Sub, and Cloud Resource Manager APIs..."
gcloud services enable \
  chat.googleapis.com \
  pubsub.googleapis.com \
  cloudresourcemanager.googleapis.com

# 4. Create Pub/Sub topic + pull subscription
log "Creating Pub/Sub topic '${TOPIC_ID}'..."
gcloud pubsub topics create "${TOPIC_ID}" 2>/dev/null \
  || warn "Topic '${TOPIC_ID}' already exists — skipping."

log "Creating pull subscription '${SUBSCRIPTION_ID}'..."
gcloud pubsub subscriptions create "${SUBSCRIPTION_ID}" \
  --topic="${TOPIC_ID}" 2>/dev/null \
  || warn "Subscription '${SUBSCRIPTION_ID}' already exists — skipping."

# 5. Create the worker service account + key
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  log "Service account ${SA_EMAIL} already exists — reusing it."
else
  log "Creating service account ${SA_NAME}..."
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="Keeper Chat Worker"
fi

log "Creating service account key -> ${SA_KEY_FILE}"
gcloud iam service-accounts keys create "${SA_KEY_FILE}" \
  --iam-account="${SA_EMAIL}"

# 6. Let YOUR app's service account pull from the subscription
log "Granting Pub/Sub Subscriber on the subscription to ${SA_EMAIL}..."
gcloud pubsub subscriptions add-iam-policy-binding "${SUBSCRIPTION_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/pubsub.subscriber"

# 7. Let Google Chat PUBLISH events to your topic
log "Granting Pub/Sub Publisher on the topic to Google Chat (${CHAT_PUSH_SA})..."
gcloud pubsub topics add-iam-policy-binding "${TOPIC_ID}" \
  --member="serviceAccount:${CHAT_PUSH_SA}" \
  --role="roles/pubsub.publisher"

# 8. Generate config.yaml
log "Writing config.yaml..."
cat > config.yaml <<YAML
google:
  project_id: "${PROJECT_ID}"
  subscription_id: "${SUBSCRIPTION_ID}"
  topic_id: "${TOPIC_ID}"
  credentials_file: "${SA_KEY_FILE}"

chat:
  app_name: "${APP_NAME}"
  command_request_record_id: ${COMMAND_ID}
  approvals_space_id: "spaces/REPLACE_ME_AFTER_ADDING_APP_TO_SPACE"

keeper:
  service_url: "http://localhost:8900/api/v2/"
  api_key: ""
YAML

# ------------------------- Manual steps (no API) --------------------------
cat <<MANUAL

======================================================================
 Infrastructure is ready. Now complete the MANUAL steps below.
 (Google has no API/manifest for the Chat app configuration tab.)
======================================================================

Project:            ${PROJECT_ID}
Topic (full path):  projects/${PROJECT_ID}/topics/${TOPIC_ID}
Subscription:       ${SUBSCRIPTION_ID}
Worker SA:          ${SA_EMAIL}
Key file:           ${SA_KEY_FILE}

MANUAL STEPS — Google Chat API Configuration (~2 min)
-----------------------------------------------------
1. Console -> APIs & Services -> Google Chat API -> Configuration tab.

2. ⚠️  Leave "Build this Chat app as a Google Workspace add-on" UNCHECKED.
      (This is permanently locked after Save. An add-on cannot receive
       button clicks over Pub/Sub — you'd have to start a new project.)

3. Application info:
      App name:    ${APP_NAME}
      Avatar URL:  https://developers.google.com/chat/images/quickstart-app-avatar.png
      Description: Keeper record access approvals

4. Interactive features: ENABLE.
      Functionality: check "Receive 1:1 messages" AND
                     "Join spaces and group conversations".

5. Connection settings: select "Cloud Pub/Sub" and paste EXACTLY:
      projects/${PROJECT_ID}/topics/${TOPIC_ID}

6. Commands -> Add a command:
      Command ID:  ${COMMAND_ID}         (must match config.yaml)
      Name:        ${SLASH_COMMAND}
      Description: Request access to a Keeper record
      Type:        Slash command

7. Visibility: add your email (and approvers) to test before publishing.

8. App status: set to LIVE. Click Save.

FINAL STEPS
-----------
a. In Google Chat, create/choose an approvals space and add the
   "${APP_NAME}" app to it (+ -> Add apps).
b. Run 'npm start', send any message to the app, and copy the
   'space.name' from the logs into config.yaml -> chat.approvals_space_id.
c. Restart 'npm start' and test:
      ${SLASH_COMMAND} "AWS test" need staging access

Full details: see SETUP-AUTOMATION.md
======================================================================
MANUAL
