# Publishing Internal — Google Workspace Marketplace (Private)

Private (org-only) publish for the Keeper Google Chat app.  
Visibility is permanent: choose **Private** only (do not choose Public).

**Recommended settings for this product**

| Setting | Value |
|--------|--------|
| App visibility | **Private** |
| App installation | **Admin Only Install** |
| App integration | **Google Chat app** only |
| Chat API status | **Live** |

With **Admin Only Install**, a Workspace admin installs once for the domain/OU. End users do **not** install anything themselves.

You must use a **Google Workspace work/school account** (not personal `@gmail.com`).

Official docs: [How to publish](https://developers.google.com/workspace/marketplace/how-to-publish) · [Configure Marketplace SDK](https://developers.google.com/workspace/marketplace/enable-configure-sdk) · [Create a store listing](https://developers.google.com/workspace/marketplace/create-listing)

---

## Before you start (checklist)

- [ ] Chat app already works (Pub/Sub + worker + slash commands).
- [ ] Same Google Cloud project as Google Chat API.
- [ ] IAM: Owner/Editor, or Marketplace role `roles/appmetadata.workspaceMarketplaceAppConfigurationAdmin`.
- [ ] **Chat API → Configuration → App status = Live**.
- [ ] Assets ready:
  - App name (≤ 50 characters; do not use “Google” in the name)
  - Short description (≤ 200 characters)
  - Detailed description
  - Icons: **32×32** and **128×128** PNG
  - Banner: **220×140**
  - ≥ 1 screenshot (recommended **1280×800**, full-bleed, square corners)
  - Public URLs: **Terms of service**, **Privacy policy**, **Support**

---

## Phase 1 — Enable Marketplace SDK

1. Open [Google Cloud Console](https://console.cloud.google.com).
2. Select the Cloud project that owns your Chat app.
3. Go to **APIs & Services** → **Library**.
4. Search for **Google Workspace Marketplace SDK**.
5. Open it and click **Enable**.

---

## Phase 2 — App Configuration (set Private)

1. Go to **APIs & Services** → **Google Workspace Marketplace SDK** → **App Configuration**  
   (or search “Marketplace SDK” → **Manage** → **App Configuration**).

2. **App visibility** (critical — cannot change later)
   - Select **Private**.
   - Only users in **your organization** can find/install the app.
   - Leave **Unlisted** off unless you want URL-only access (no Internal Apps browse/search).

3. **App installation**
   - Select **Admin Only Install**.
   - Only Workspace admins install from Marketplace.
   - Admins deploy for domain / OU / group; end users get the app with no personal install.

4. **App integrations**
   - Check **Google Chat app** only.
   - Do **not** also select “Google Workspace add-on” unless you actually have one.
   - Interaction events / Pub/Sub stay configured under **Google Chat API → Configuration** (not here).

5. **OAuth scopes**
   - Enter the OAuth 2.0 scopes your app requires.
   - They must match the OAuth consent screen (and any Apps Script manifest if used).

6. **Developer information**
   - Trader / Non-trader (EEA display).
   - Developer name.
   - Developer email (Google may contact you here).
   - Developer website.
   - Mailing address if Trader.
   - Optional application website.

7. Click **Save** / **Save Draft**.

---

## Phase 3 — Store Listing (required for Private)

1. Go to **APIs & Services** → **Google Workspace Marketplace SDK** → **Store Listing**.

2. **App details**
   - Language (default + any translations).
   - Application name (align with Chat display name).
   - Short description.
   - Detailed description.
   - Category.

3. **Graphic assets**
   - Upload icons (**32×32**, **128×128**).
   - Upload card banner (**220×140**).
   - Upload at least one screenshot of the Chat app in use.

4. **Support links** (required)
   - Terms of service URL.
   - Privacy policy URL.
   - Support URL.

5. Optional
   - Pricing → **Free of charge** (if applicable).
   - Promo video.
   - Setup / Admin config URLs (self-hosted Commander / worker setup).

6. **Distribution** (optional): leave all regions, or limit as needed.

---

## Phase 4 — Publish (internal goes live immediately)

1. On **Store Listing**, finish all required fields.
2. Click **Submit For Review** / publish (label may say “review” even for private).
3. Because visibility is **Private**:
   - Listing publishes **immediately** for your organization.
   - **No** Google public Marketplace review.
4. Confirm publication status at the top of the Store Listing page.
5. Confirm again: **Google Chat API → Configuration → App status = Live**.  
   If Chat is Disabled, the Marketplace listing will not make the app usable.

---

## Phase 5 — Admin install for the organization

1. Sign in as a **Google Workspace admin** (org account).
2. Open Google Workspace Marketplace → **Internal Apps** (or open the listing URL).
3. Install the app for the **entire organization**, or for selected OUs / groups.
4. If install fails, check Admin Console for:
   - Marketplace / third-party app **allowlist**.
   - Whether **Chat apps** are allowed for users.
   - Whether Marketplace apps are allowed.

5. Keep the **self-hosted worker** running (`npm start` / Docker).  
   Marketplace does **not** host the Node app or Keeper Commander.

---

## Phase 6 — Verify

1. As a normal org user (no Marketplace install step), open Google Chat.
2. Confirm the Keeper Chat app is available (find app / slash commands).
3. Run a smoke test, e.g. `/keeper-request-record ...`.
4. Confirm Pub/Sub delivery and worker logs.
5. Confirm the approvals space still receives cards.

---

## After publish

- Update listing later: Marketplace SDK → App Configuration / Store Listing → save / publish updates.
- To unpublish: Store Listing → **Unpublish**.
- Moving the Cloud project to another org does **not** move private access; the original org keeps association. For a new org, replicate the listing in a new project under that org’s account.

---

## Quick reference

```text
Enable Marketplace SDK
  → App Configuration: Private + Admin Only + Google Chat app
  → Store Listing: details, icons, screenshots, legal links
  → Publish (immediate for Private)
  → Admin installs for domain/OU
  → Users use Chat app with no personal install
  → Keep worker + Commander running
```
