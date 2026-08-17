# Setup Guide — Keeper Google Chat Integration (from scratch)

This guide walks through every step to run the `/keeper-request-record` Google
Chat app using the **Cloud Pub/Sub** architecture (works behind a firewall, no
inbound ports, no public HTTP endpoint).

Follow the steps in order.

Values used as examples below (replace with your own):

| Item | Example value |
|------|---------------|
| GCP Project ID | `test123-501809` |
| GCP Project number | `557886250520` |
| Pub/Sub topic | `keeper-chat-events` |
| Pub/Sub subscription | `keeper-chat-events-sub` |
| Worker service account | `id-keeper-chat-worker@test123-501809.iam.gserviceaccount.com` |
| Chat app name | `Keeper Security` |
| Slash command id | `1` |

---

> ## ⚠️ READ THIS FIRST — the add-on checkbox trap
>
> On the Chat API **Configuration** page there is a checkbox at the very top:
> **"Build this Chat app as a Google Workspace add-on."**
>
> - For this Pub/Sub app you **MUST leave it UNCHECKED** (click **Disable** if
>   prompted). Only a standalone Chat app delivers `CARD_CLICKED` button events
>   over Pub/Sub. An add-on requires a synchronous HTTP/Apps Script endpoint, so
>   its buttons fail with **"Keeper Security is unable to process your request"**
>   and nothing reaches your topic.
> - **This setting is permanently locked once you Save.** It cannot be changed
>   later. If your current project was ever saved with the add-on box **checked**
>   (greyed-out/locked checkbox = it was saved ON), you **cannot fix it in that
>   project** — you must create a **brand-new GCP project** and configure it with
>   the box unchecked from the start.
>
> The code in this repo needs **no changes** for this — it already handles the
> standalone interaction-event format. This is purely a Cloud Console setup.

---

## Prerequisites

- A **Google Workspace** account (Business/Enterprise) with access to Google Chat.
- A **Google Cloud project** with billing enabled, where you are **Owner** or **Editor**.
  - If your existing project is locked as an add-on, create a **new** project here.
- **Node.js 18+** installed locally (`node --version`).

---

## Step 1 — Enable the required APIs

In the [Google Cloud Console](https ://console.cloud.google.com/), select your
project, then enable both APIs:

1. **Google Chat API** — [enable](https://console.cloud.google.com/apis/library/chat.googleapis.com)
2. **Cloud Pub/Sub API** — [enable](https://console.cloud.google.com/apis/library/pubsub.googleapis.com)

---

## Step 2 — Create a service account and key

This account lets the app pull events from Pub/Sub and post messages to Chat.

1. Go to **IAM & Admin → Service Accounts → Create service account**.
2. Name it e.g. `keeper-chat-worker`. Create.
3. Open the account → **Keys → Add key → Create new key → JSON**.
4. Save the downloaded file as `service-account.json` in the project root.

> Keep this file secret. It is already covered by `.gitignore`.

---

## Step 3 — Create the Pub/Sub topic and subscription

You need **two** resources: a **topic** (Google Chat publishes events here) and a
**pull subscription** on that topic (your app reads events from here).

### 3a. Create the topic

1. In the Cloud Console, open **Pub/Sub → Topics**
   ([direct link](https://console.cloud.google.com/cloudpubsub/topic/list)).
2. Click **Create topic**.
3. **Topic ID:** enter `keeper-chat-events`.
4. **Uncheck** "Add a default subscription" (you'll create the subscription
   manually in 3b with the exact ID the app expects).
5. Leave everything else at defaults and click **Create**.

### 3b. Create the pull subscription

1. Open **Pub/Sub → Subscriptions**
   ([direct link](https://console.cloud.google.com/cloudpubsub/subscription/list))
   and click **Create subscription**. (Or, from the topic page, click the
   3-dot menu → **Create subscription**.)
2. **Subscription ID:** enter `keeper-chat-events-sub`.
3. **Select a Cloud Pub/Sub topic:** choose `keeper-chat-events` (the topic from 3a).
4. **Delivery type:** select **Pull** (this is the default — do NOT choose Push).
5. Leave all other fields at defaults and click **Create**.

> The IDs must match your `config.yaml` exactly: `topic_id: keeper-chat-events`
> and `subscription_id: keeper-chat-events-sub`.

### Alternative: create both with the CLI

If you have the `gcloud` CLI installed and authenticated, run:

```bash
gcloud config set project test123-501809

gcloud pubsub topics create keeper-chat-events

gcloud pubsub subscriptions create keeper-chat-events-sub \
  --topic=keeper-chat-events
```

---

## Step 4 — Grant IAM permissions (critical)

Two separate grants are required. Missing either causes
**"Keeper Security is not responding"** or events never arriving.

### 4a. Let Google Chat publish to the topic

**Pub/Sub → Topics → `keeper-chat-events` → Permissions → Grant access.**

Add the following as **Pub/Sub Publisher**:

| Principal | Role |
|-----------|------|
| `chat-api-push@system.gserviceaccount.com` | Pub/Sub Publisher |

> This is the fixed system account Google Chat uses to publish events for a
> standalone (non-add-on) Chat app. Confirm the exact **Service Account Email**
> shown on the Chat API Configuration page (Step 6) matches, and grant Publisher
> to whatever it displays.

### 4b. Let the worker read the subscription

**Pub/Sub → Subscriptions → `keeper-chat-events-sub` → Permissions → Grant access.**

| Principal | Role |
|-----------|------|
| `keeper-chat-worker@test123-501809.iam.gserviceaccount.com` | Pub/Sub Subscriber |

---

## Step 5 — Install and configure the app

From the project root:

```bash
npm install
```

Create `config.yaml` (copy from `config.example.yaml`):

```yaml
google:
  project_id: "test123-501809"
  subscription_id: "keeper-chat-events-sub"
  topic_id: "keeper-chat-events"
  credentials_file: "./service-account.json"

chat:
  app_name: "Keeper Security"
  command_request_record_id: 1
  command_request_folder_id: 2
  command_external_share_id: 3
  command_create_secret_id: 4
  approvals_space_id: "spaces/REPLACE_AFTER_STEP_7"

keeper:
  mock_mode: true
  service_url: "http://localhost:8900/api/v2/"
  api_key: ""

logging:
  level: "info"
  pretty: true
```



> Keep `mock_mode: true` for UI testing without a live Keeper Commander.

---

## Step 6 — Configure the Chat app

Go to **APIs & Services → Google Chat API → Configuration**.

1. **Build this Chat app as a Google Workspace add-on:** leave **UNCHECKED**. If a
   confirmation dialog appears, click **Disable**. (See the warning at the top of
   this guide — this cannot be changed after Save.)
2. **App name:** `Keeper Security`
3. **Avatar URL:** any square PNG URL (e.g. `https://developers.google.com/chat/images/quickstart-app-avatar.png`)
4. **Description:** `Approval workflow app`
5. **Functionality:** check **Receive 1:1 messages** and **Join spaces and group conversations**.
6. **Connection settings:** select **Cloud Pub/Sub** and paste the full topic path:

   ```text
   projects/test123-501809/topics/keeper-chat-events
   ```

   Note the **Service Account Email** shown here — it must have Publisher on the
   topic (Step 4a).
7. **Commands → Add a command:**
   - Name: `/keeper-request-record`
   - Command ID: `1`
   - Description: `Request access to a Keeper record`
   - Type: **Slash command**
8. **Commands → Add another command:**
   - Name: `/keeper-request-folder`
   - Command ID: `2` (must match `chat.command_request_folder_id`)
   - Description: `Request access to a Keeper folder`
   - Type: **Slash command**
9. **Commands → Add another command:**
   - Name: `/keeper-external-share`
   - Command ID: `3` (must match `chat.command_external_share_id`)
   - Description: `Create an external share link for a Keeper record`
   - Type: **Slash command**
10. **Commands → Add another command:**
   - Name: `/keeper-create-secret`
   - Command ID: `4` (must match `chat.command_create_secret_id`)
   - Description: `Create a secret record in a shared folder`
   - Type: **Slash command**
11. **Visibility:** select "available to specific people…" and add your own email.
12. **App status:** set to **LIVE**.
13. Click **Save**.

---

## Step 7 — Create the approvals space

1. In Google Chat, create a space, e.g. `keeper-vault-approvers`.
2. Add the **Keeper Security** app to that space (`+ → Add apps`).
3. Get the space ID and put it in `config.yaml` as `approvals_space_id`.

To find the space ID, run the app once (Step 8), send any message to it, and
read the `space.name` in the logs.

Set the value, for example:

```yaml
  approvals_space_id: "spaces/AAQAjNCfaao"
```

---

## Step 8 — Run

```bash
npm start
```

Healthy startup logs:

```text
INFO: Starting Pub/Sub listener (Subscriber role required)
INFO: Keeper Commander reachable   mode: "mock"
INFO: Pulling Google Chat events
INFO: Waiting for Google Chat events...
```

---

## Step 9 — Test the flow

In a DM with the **Keeper Security** app (or in the approvals space), send a
**description-based** request:

```text
/keeper-request-record "AWS test" need staging access
```

Expected:

1. Terminal logs `Received Chat event   eventType: "MESSAGE"` with no error.
2. You get a private confirmation reply.
3. An **approval card** appears in the approvals space with a **Search Records** button.
4. Click **Search Records** → terminal logs `eventType: "CARD_CLICKED"` and the
   card updates to a list of matching records (radio buttons) + permission /
   duration selectors.
5. Select a record → click **Approve** → the card updates to "Approved" and the
   requester receives a DM.

A **UID-based** request also works (skips the search step):

```text
/keeper-request-record kR3cF9Xm2Lp8NqT1uV6w need staging access
```

The UID must be **20–24 characters** (POC validation). Example valid UID:
`kR3cF9Xm2Lp8NqT1uV6w`.

---

## Offline test (no GCP)

To validate the request → search → approval flow end-to-end without Google Cloud:

```bash
npm run test:local
```

---

## Quick troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "Keeper Security is not responding", no logs in `run.py` | Chat can't publish. Verify Step 4a (both publisher accounts) and Step 6 (Connection settings = Cloud Pub/Sub, exact topic path, Save). |
| `PermissionDenied` pulling subscription | Missing Step 4b (worker → Pub/Sub Subscriber on subscription). |
| Approval card not posted to approvals space | App is not a member of that space (Step 7), or wrong `approvals_space_id`. |
| `headers.forEach is not a function` on Chat API call | Version mismatch — run `npm install` to pull `google-auth-library ^10.x`. |
| Events arrive as `chat.appCommandPayload` / `chat.buttonClickedPayload` | App is still in **add-on** mode. Only classic `{type: "CARD_CLICKED"}` events support the Pub/Sub button flow — create a standalone project. |
