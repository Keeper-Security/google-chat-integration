# Automated Setup — Keeper Google Chat Integration

This guide explains how to set up the Google Chat app **as automatically as
Google allows**, and exactly which steps still have to be done by hand.

## TL;DR — Can Chat app setup be fully automated?

**Not fully.** Google provides:

- ✅ An API/CLI (`gcloud`) for all the **infrastructure** (project, APIs,
  Pub/Sub, service account, IAM).
- ❌ **No API or manifest** for the **Chat app configuration** (app name, avatar,
  slash commands, Pub/Sub connection, visibility). This is confirmed in Google's
  own docs and **must be done in the Cloud Console**.

So we automate ~85% with a script (`scripts/setup-gcp.sh`) and leave the final
~2-minute Console step manual.

| Task | Automated? | How |
|------|-----------|-----|
| Create GCP project | ✅ | `gcloud projects create` |
| Enable Chat + Pub/Sub APIs | ✅ | `gcloud services enable` |
| Create Pub/Sub topic | ✅ | `gcloud pubsub topics create` |
| Create pull subscription | ✅ | `gcloud pubsub subscriptions create` |
| Create service account + key | ✅ | `gcloud iam service-accounts …` |
| Grant IAM (Subscriber + Publisher) | ✅ | `gcloud … add-iam-policy-binding` |
| Generate `config.yaml` | ✅ | script writes it |
| **App name / avatar / description** | ❌ | Console → Chat API → Configuration |
| **Slash command `/keeper-request-record`** | ❌ | Console → Chat API → Configuration |
| **Slash command `/keeper-request-folder`** | ❌ | Console → Chat API → Configuration |
| **Pub/Sub connection setting** | ❌ | Console → Chat API → Configuration |
| **Visibility / LIVE status** | ❌ | Console → Chat API → Configuration |

---

## Part A — Automated infrastructure (the script)

### Prerequisites

- **gcloud CLI** installed and authenticated:

```bash
gcloud auth login
```

- A **Google Workspace** (Business/Enterprise) account with Google Chat.
- Permission to create/edit the target GCP project (**Owner** or **Editor**).
- **Node.js 18+** (`node --version`).

### Run it

From the project root:

```bash
chmod +x scripts/setup-gcp.sh

# Minimal (auto-generates a project ID):
./scripts/setup-gcp.sh

# Recommended (choose your own project + link billing):
PROJECT_ID=keeper-gchat-prod \
BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX \
  ./scripts/setup-gcp.sh
```

### What it does, in order

1. Creates (or reuses) the GCP project and sets it as active.
2. Links billing (if `BILLING_ACCOUNT_ID` is provided).
3. Enables `chat.googleapis.com`, `pubsub.googleapis.com`,
   `cloudresourcemanager.googleapis.com`.
4. Creates the topic `keeper-chat-events`.
5. Creates the **pull** subscription `keeper-chat-events-sub`.
6. Creates the service account `keeper-chat-worker` and downloads
   `service-account.json` to the project root.
7. Grants **Pub/Sub Subscriber** on the subscription to the worker SA.
8. Grants **Pub/Sub Publisher** on the topic to Google Chat's system account
   (`chat-api-push@system.gserviceaccount.com`).
9. Writes `config.yaml` with all values filled in.
10. Prints the manual steps (Part B) with your exact project values.

### Overridable variables

| Variable | Default |
|----------|---------|
| `PROJECT_ID` | `keeper-gchat-<timestamp>` |
| `BILLING_ACCOUNT_ID` | *(unset)* |
| `TOPIC_ID` | `keeper-chat-events` |
| `SUBSCRIPTION_ID` | `keeper-chat-events-sub` |
| `SA_NAME` | `keeper-chat-worker` |
| `SA_KEY_FILE` | `./service-account.json` |
| `APP_NAME` | `Keeper Security` |
| `COMMAND_ID` | `1` |
| `SLASH_COMMAND` | `/keeper-request-record` |

---

## Part B — Manual steps (Chat API Configuration, ~2 min)

> ### ⚠️ The add-on checkbox trap (read first)
> On the Chat API **Configuration** page, the checkbox **"Build this Chat app as
> a Google Workspace add-on"** must be left **UNCHECKED**. Only a standalone Chat
> app delivers button-click (`CARD_CLICKED`) events over Pub/Sub. **This setting
> is permanently locked once you Save** — if it was ever saved ON, you must
> create a brand-new project (re-run the script with a new `PROJECT_ID`).

1. Go to **Console → APIs & Services → Google Chat API → Configuration**.
2. **Leave the add-on checkbox UNCHECKED** (click **Disable** if prompted).
3. **Application info:**
   - App name: `Keeper Security`
   - Avatar URL: `https://developers.google.com/chat/images/quickstart-app-avatar.png`
   - Description: `Keeper record access approvals`
4. **Interactive features:** ENABLE. Under **Functionality**, check both
   **Receive 1:1 messages** and **Join spaces and group conversations**.
5. **Connection settings:** select **Cloud Pub/Sub** and paste the exact topic
   path the script printed:

   ```text
   projects/<YOUR_PROJECT_ID>/topics/keeper-chat-events
   ```

6. **Commands → Add a command:**
   - Command ID: `1` (must match `config.yaml → chat.command_request_record_id`)
   - Name: `/keeper-request-record`
   - Description: Request access to a Keeper record
   - Type: **Slash command**
7. Add a second slash command:
   - Command ID: `2` (must match `config.yaml → chat.command_request_folder_id`)
   - Name: `/keeper-request-folder`
   - Description: Request access to a Keeper folder
   - Type: **Slash command**
8. Add a third slash command:
   - Command ID: `3` (must match `config.yaml → chat.command_external_share_id`)
   - Name: `/keeper-external-share`
   - Description: Create an external share link for a Keeper record
   - Type: **Slash command**
9. Add a fourth slash command:
   - Command ID: `4` (must match `config.yaml → chat.command_create_secret_id`)
   - Name: `/keeper-create-secret`
   - Description: Create a secret record in a shared folder
   - Type: **Slash command**
10. **Visibility:** add your email (and approvers) to test before publishing.
11. **App status:** set to **LIVE**, then click **Save**.

---

## Part C — Finish and run

1. Install dependencies:

```bash
npm install
```

2. In Google Chat, create an approvals space (e.g. `keeper-vault-approvers`) and
   add the **Keeper Security** app to it (`+ → Add apps`).
3. Start the app, send any message to it, and copy the `space.name` from the logs
   into `config.yaml → chat.approvals_space_id`:

```bash
npm start
```

```yaml
chat:
  approvals_space_id: "spaces/AAQAjNCfaao"
```

4. Restart and test:

```bash
npm start
```

```text
/keeper-request-record "AWS test" need staging access
```

You should see the approval card appear in the approvals space with a
**Search Records** button.

---

## Offline test (no GCP needed)

To validate the request → search → approval flow without Google Cloud:

```bash
npm run test:local
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| APIs fail to enable | Billing not linked. Set `BILLING_ACCOUNT_ID` and re-run, or link billing in the console. |
| `gcloud: command not found` | Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and run `gcloud auth login`. |
| "Keeper Security is not responding", no logs | Chat can't publish. Confirm the Pub/Sub connection (Part B step 5) and that Publisher was granted to `chat-api-push@system.gserviceaccount.com`. |
| `PermissionDenied` pulling subscription | Worker SA missing **Pub/Sub Subscriber** on the subscription (script step 7). |
| Approval card not posted to space | App not added to the space, or wrong `approvals_space_id` (Part C step 2–3). |
| Events arrive as `chat.appCommandPayload` / `chat.buttonClickedPayload` and buttons fail | App is in **add-on** mode. Create a new project with the add-on box unchecked. |

---

## Why the manual step can't be automated

Google's documentation is explicit that the Chat app's display name, avatar,
slash commands, and Pub/Sub connection are configured **only** through the Cloud
Console's Chat API Configuration page — there is no public API, `gcloud`
command, or manifest for it. See:

- [Configure the Google Chat API](https://developers.google.com/workspace/chat/configure-chat-api)
- [Build a Chat app that uses Pub/Sub](https://developers.google.com/workspace/add-ons/chat/quickstart-pubsub)
- [Respond to Google Chat app commands](https://developers.google.com/workspace/chat/slash-commands)

This is a platform limitation, not a limitation of this project.
