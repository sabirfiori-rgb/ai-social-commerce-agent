# Setup

Step-by-step installation and credential configuration, from "nothing
installed" to every optional integration connected. Work through
[Prerequisites](#prerequisites) and [Base install](#base-install) first —
everything after that is optional and can be added incrementally, in any
order, whenever you're ready to connect a particular source, publisher, AI
provider, or a real Google Sheet.

## Contents

- [Prerequisites](#prerequisites)
- [Base install](#base-install)
- [Core environment variables](#core-environment-variables)
- [Google service account (Sheet + Drive)](#google-service-account-sheet--drive)
- [Product source credentials](#product-source-credentials)
- [Social publisher credentials](#social-publisher-credentials)
- [AI provider keys](#ai-provider-keys)
- [Verifying your setup](#verifying-your-setup)

## Prerequisites

- **Node.js 22.6 or newer.** This is a hard requirement, not just a
  recommendation — the app uses `node:sqlite` (added in 22.5, stabilized
  shortly after) and relies on Node's native TypeScript type-stripping to
  run `.ts` files directly with no build step. Check with:
  ```bash
  node --version
  ```
- **`ffmpeg` and `ffprobe` on `PATH`.** Required only for video rendering;
  every other pipeline stage works without them. Install via your package
  manager:
  ```bash
  # Debian/Ubuntu
  sudo apt-get install -y ffmpeg
  # macOS
  brew install ffmpeg
  ```
  Verify with `ffmpeg -version` and `ffprobe -version`. If your binaries
  live somewhere non-standard, point `FFMPEG_PATH`/`FFPROBE_PATH` at them
  instead of relying on `PATH`.
- Everything else the app needs at runtime — a SQLite driver, an HTTP
  server, an HTTP client, a crypto library, an SVG rasterizer — ships
  inside Node itself or is vendored under `vendor/` (the `resvg-wasm`
  binary and the Poppins font files). There is no third prerequisite.

## Base install

```bash
git clone <your fork/clone of this repository>
cd ai-social-commerce-agent

# Installs only the two dev-time tools (typescript, @types/node) used for
# type-checking and running the test suite. There are no runtime packages
# to install — node_modules/ will be small.
npm install

cp .env.example .env
```

Generate the required encryption key (used to encrypt any social-account
credentials you save through the dashboard/API) and paste it into
`ENCRYPTION_KEY=` in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

At this point the app is fully runnable in local mode with zero further
configuration:

```bash
node scripts/seed.ts       # provisions a demo brand + 2 demo products
node scripts/run-once.ts   # runs the pipeline once, synchronously
node src/main.ts           # starts the API + worker; open http://localhost:8080
```

Everything below this point is optional, additive configuration for
connecting real integrations.

## Core environment variables

These control the process itself, independent of any specific integration:

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `LOG_LEVEL` | see `.env.example` | `debug`/`info`/`warn`/`error` |
| `LOG_PRETTY` | see `.env.example` | Pretty console output vs. JSON lines |
| `HTTP_PORT` | `8080` | |
| `HTTP_HOST` | `0.0.0.0` | |
| `PUBLIC_BASE_URL` | unset | Used when constructing publicly reachable media URLs |
| `ENCRYPTION_KEY` | **required** | 32-byte value, hex-encoded (64 hex characters) |
| `SQLITE_PATH` | `./data/app.db` | |
| `DATABASE_DRIVER` | `sqlite` | `postgres` is a documented scale-up path — see `docs/DEPLOYMENT.md` |
| `STORAGE_DRIVER` | `local` | `local` or `gdrive` |
| `STORAGE_LOCAL_DIR` | `./data/output` | Where rendered assets/videos land when `STORAGE_DRIVER=local` |

## Google service account (Sheet + Drive)

Needed only if you want a real Google Sheet as the control surface
(`SHEET_STORE=google`) and/or Google Drive as the storage backend
(`STORAGE_DRIVER=gdrive`). Both reuse the exact same service account.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create
   or select a project.
2. **APIs & Services → Library** — enable the **Google Sheets API**, and
   the **Google Drive API** if you'll use Drive for storage.
3. **APIs & Services → Credentials → Create Credentials → Service
   account.** Give it any name; no special roles are required (access is
   granted per-Sheet by sharing, not by IAM role).
4. Open the new service account → **Keys → Add key → Create new key →
   JSON.** This downloads a JSON key file — treat it like a password.
5. Save it as `./credentials/service-account.json` (the `credentials/`
   directory already exists and is git-ignored), or copy its contents into
   `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env` instead (handy for containerized
   deployments where mounting a file is inconvenient — set one or the
   other, not both).
6. Create the Google Sheet you want to use as the control surface (or reuse
   an existing one), open its **Share** dialog, and add the service
   account's `client_email` (found inside the JSON key file) as an
   **Editor**. Without this share step every Sheets API call will fail with
   a permissions error, since the service account has no access of its own
   to any Sheet you haven't explicitly shared with it.
7. Copy the spreadsheet ID out of the Sheet's URL
   (`https://docs.google.com/spreadsheets/d/<THIS PART>/edit`) into
   `GOOGLE_SHEETS_SPREADSHEET_ID`.
8. Set `SHEET_STORE=google` (and `STORAGE_DRIVER=gdrive` +
   `GDRIVE_FOLDER_ID` if you also want Drive storage — the folder must
   likewise be shared with the service account as an Editor).

On next boot the app authenticates by signing an RS256 JWT with the service
account's private key and exchanging it for an access token
(`oauth2.googleapis.com/token`) — there's no separate OAuth consent screen
to click through, since a service account authenticates as itself. It then
calls `ensureSchema()`, which creates any missing tabs and header rows and
a hidden `_Locks` tab, without touching any data that's already there.

Optionally, install the Apps Script bundle in `apps-script/` for an
in-Sheet "AI Agent" menu — see [`apps-script/README.md`](../apps-script/README.md)
for the full binding/authorization walkthrough. This is a convenience for
operators who want to add products or trigger a poll from inside the
Sheet itself; the backend's own polling loop works with or without it.

## Product source credentials

Only configure the sources you intend to use — `manual` and `csv` need
nothing and are enough to exercise the whole pipeline.

### Amazon (Product Advertising API v5)

```
AMAZON_PAAPI_ACCESS_KEY=...
AMAZON_PAAPI_SECRET_KEY=...
AMAZON_PAAPI_PARTNER_TAG=...
AMAZON_PAAPI_HOST=webservices.amazon.com     # region-specific host
AMAZON_PAAPI_REGION=us-east-1                # region-specific SigV4 region
```

You need an active **Amazon Associates** account and a **Partner Tag**
(your Associates tracking ID), then apply for **Product Advertising API**
access from the Associates Central dashboard (approval typically requires
some qualifying sales history). Once approved, generate an access
key/secret key pair from the PA-API console. Requests are signed with AWS
Signature Version 4 — this integration talks to the official PA-API
endpoint exclusively; it does not scrape Amazon's website.

### Shopify

```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_...
SHOPIFY_API_VERSION=2024-10
```

In your Shopify admin: **Settings → Apps and sales channels → Develop
apps → Create an app.** Configure Admin API scopes to include read access
to products (`read_products`), install the app to your store, and copy the
generated **Admin API access token** (shown once, starts with `shpat_`).

### WooCommerce

```
WOOCOMMERCE_BASE_URL=https://your-store.example.com
WOOCOMMERCE_CONSUMER_KEY=ck_...
WOOCOMMERCE_CONSUMER_SECRET=cs_...
```

In WordPress admin: **WooCommerce → Settings → Advanced → REST API → Add
key.** Grant at least **Read** permissions and generate the consumer
key/secret pair.

### Etsy

```
ETSY_API_KEY=...
ETSY_ACCESS_TOKEN=...
ETSY_SHOP_ID=...
```

Register an app at the [Etsy Developer portal](https://www.etsy.com/developers/)
to get an API key (keystring), then complete Etsy's OAuth 2.0 flow for your
shop to obtain an access token with at least `listings_r` scope. Your numeric
shop ID is visible in your shop's dashboard URL/settings.

### Flipkart (Affiliate API)

```
FLIPKART_AFFILIATE_ID=...
FLIPKART_AFFILIATE_TOKEN=...
```

Apply for the [Flipkart Affiliate program](https://affiliate.flipkart.com/);
once approved, your affiliate ID and API token are available from the
affiliate dashboard's API access section.

### Meesho

```
MEESHO_API_TOKEN=...
MEESHO_BASE_URL=...
```

Meesho does not run a single fixed public catalog API — `MEESHO_BASE_URL`
is intentionally configurable so this source can point at whatever partner
or catalogue API endpoint your Meesho seller/partner integration actually
issues credentials for. Obtain the token and base URL from that program's
partner onboarding process.

## Social publisher credentials

`DRY_RUN=true` by default, and every publisher additionally self-disables
into dry-run mode if its own credentials are absent — so it's safe to leave
this section entirely unconfigured while you evaluate the rest of the
system. Configure only the platforms you intend to post to.

### Instagram

```
META_GRAPH_VERSION=v20.0
INSTAGRAM_ACCESS_TOKEN=...
INSTAGRAM_BUSINESS_ACCOUNT_ID=...
```

Requires an **Instagram professional (Business/Creator) account** linked to
a **Facebook Page**, and a **Meta developer app** with the
`instagram_content_publish` permission. Generate a long-lived Page/user
access token via the [Meta Graph API Explorer](https://developers.facebook.com/tools/explorer/)
or your app's token-generation flow, and look up the linked Instagram
Business Account ID via `GET /{page-id}?fields=instagram_business_account`.

### Facebook

```
FACEBOOK_PAGE_ID=...
FACEBOOK_PAGE_ACCESS_TOKEN=...
```

From the same Meta developer app, generate a **Page access token** (not a
user token) with `pages_manage_posts` and `pages_read_engagement`
permissions, scoped to the specific Page you want to post to.

### LinkedIn

```
LINKEDIN_ACCESS_TOKEN=...
LINKEDIN_AUTHOR_URN=urn:li:person:... (or urn:li:organization:...)
```

Create an app at the [LinkedIn Developer portal](https://www.linkedin.com/developers/),
request the **Share on LinkedIn** / **w_member_social** (or
**w_organization_social** for a Company Page) product, and complete
LinkedIn's OAuth 2.0 flow to get an access token. The author URN identifies
whether posts are authored as a person or an organization.

### Pinterest

```
PINTEREST_ACCESS_TOKEN=...
PINTEREST_DEFAULT_BOARD_ID=...
```

Register an app in [Pinterest's Developer portal](https://developers.pinterest.com/),
request the `pins:write`/`boards:read` scopes, and complete OAuth to get an
access token. The default board ID is visible in a board's URL or via the
Pinterest API's list-boards endpoint.

### Threads

```
THREADS_ACCESS_TOKEN=...
THREADS_USER_ID=...
```

Threads publishing goes through Meta's separate Threads API
(`graph.threads.net`), configured from the same Meta developer app family
as Instagram/Facebook — request Threads API access and generate a
long-lived Threads access token; the numeric Threads user ID is returned by
that token's own `/me` lookup.

### X (Twitter)

```
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

All four values are required together — this publisher signs requests with
OAuth 1.0a (implemented locally; no `twitter-api` package is used). Create
a project/app in the [X Developer Portal](https://developer.x.com/), enable
OAuth 1.0a with **Read and Write** permissions, and generate both the
app-level API key/secret and a user-level access token/secret pair.

## AI provider keys

`AI_PROVIDER=template` needs no key at all and is the default. Configure
one of the following only if you want LLM-generated copy instead of the
deterministic template generator:

| Provider | Variable(s) | Where to get a key |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` (optional: `OPENAI_MODEL`, `OPENAI_BASE_URL`) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Gemini | `GEMINI_API_KEY` (optional: `GEMINI_MODEL`) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Anthropic | `ANTHROPIC_API_KEY` (optional: `ANTHROPIC_MODEL`) | [console.anthropic.com](https://console.anthropic.com/) |

Set `AI_PROVIDER` to `openai`, `gemini`, or `anthropic` to activate the
corresponding client. If the model's JSON response is malformed or missing
fields, the generator backfills from the same template logic used by
`AI_PROVIDER=template`, so a bad LLM response degrades gracefully rather
than failing the pipeline.

## Verifying your setup

After changing `.env`, restart the app and check:

```bash
curl http://localhost:8080/api/health
```

The response lists every source and publisher with an `isConfigured`
boolean, plus the active `aiProvider`, `sheet` kind, and `storage` kind —
this is the fastest way to confirm a credential change actually took
effect before running a real product through the pipeline. See
[`docs/API.md`](API.md) for the full response shape, and
[`docs/TESTING.md`](TESTING.md) for how to exercise the pipeline end to
end with `scripts/seed.ts`/`scripts/run-once.ts` once you're ready to
verify a specific integration.
