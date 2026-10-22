# Setla backend

Node.js / Express API for the sibling `../setla` Next.js website. Supabase Auth verifies Google accounts, PostgreSQL stores application data, and a private Supabase Storage bucket holds originals and previews.

## Set up Supabase

1. Create a Supabase project. In the SQL editor run `supabase/migrations/202610220001_setla.sql` once, or initialize CLI configuration with `supabase init`, link your project, and run `supabase db push`. This creates all six tables, indexes, a service-only transactional API function, RLS restrictions, and the private `setla-resources` bucket.
2. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from Project Settings / API Keys. Use a server secret (`sb_secret_...`) or the legacy `service_role` key. Keep this key only on the backend. Keep `SUPABASE_STORAGE_BUCKET=setla-resources`, unless you deliberately create another equivalent private bucket.
3. Under Supabase Authentication / Providers, enable Google with your Google OAuth client ID and secret. In Google Cloud OAuth configuration add the callback URL shown by Supabase (normally `https://PROJECT_REF.supabase.co/auth/v1/callback`). Configure the consent screen; if the Google app is in testing, add your test accounts.
4. Under Supabase Authentication / URL Configuration set Site URL to the website. Allow `http://localhost:3000/**` locally and only your production domain/path patterns in production. Frontend OAuth uses PKCE and returns to the page that initiated sign-in.
5. In `../setla/.env.local`, configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (publishable or legacy anon key), and `NEXT_PUBLIC_API_URL`. Both repositories must use the same Supabase project. Never put a server secret in any `NEXT_PUBLIC_*` variable.
6. Set `FRONTEND_ORIGINS` to exact allowed website origins separated by commas. Configure `TRUST_PROXY` for your hosting provider's actual proxy topology.

Supabase browsers authenticate only; the Express API handles all database and file access. Application tables have RLS enabled and no browser grants or policies. The `setla_api` function runs with invoker privileges and is executable only by `service_role`. Do not grant its execution to `anon` or `authenticated`: its actor argument must come from a token verified by the backend. The private storage bucket has no browser policies. Public preview responses go through the API; original downloads require a verified Google account and expire after five minutes.

## Run locally

Requires Node.js 22 or newer:

```sh
npm ci
npm run dev
```

The API listens on http://localhost:4000. `GET /health` checks process liveness only, not Supabase connectivity. Start the frontend separately. Upload resources you have permission to share; sample assets are not seeded.

## API

All endpoints return JSON except image previews and successful deletes. Protected endpoints accept `Authorization: Bearer <Supabase access token>`; the frontend obtains and refreshes this token using the Supabase client SDK. No separate backend password or Google client secret is needed.

| Method | Path | Access / behavior |
| --- | --- | --- |
| GET | `/health` | Public liveness |
| GET | `/api/categories` | Public category list |
| GET | `/api/resources?q=&category=&limit=24&cursor=` | Public search and browsing |
| GET | `/api/resources/:id` | Public details |
| GET | `/api/resources/:id/preview` | Public preview image |
| GET | `/api/me` | Google account; sync profile from verified identity |
| GET | `/api/me/activity` | Own liked and saved resource IDs |
| GET | `/api/me/saved?limit=24&cursor=` | Own saved resources |
| GET | `/api/me/resources?limit=24&cursor=` | Own uploads |
| POST | `/api/resources` | Google account; multipart upload |
| PATCH | `/api/resources/:id` | Creator only; title, description, category |
| DELETE | `/api/resources/:id` | Creator only; deletes resource and files |
| PUT | `/api/resources/:id/likes` | Google account; `{ "enabled": true }` or false |
| PUT | `/api/resources/:id/saves` | Google account; `{ "enabled": true }` or false |
| POST | `/api/resources/:id/download` | Google account; signed URL valid for 5 minutes |
| GET | `/api/freelancers?limit=24&cursor=` | Public directory of published profiles |
| GET | `/api/freelancers/:id` | Public published profile; otherwise 404 |
| GET | `/api/me/freelancer` | Own profile, including drafts; null before creation |
| PUT | `/api/me/freelancer` | Create or replace own profile |
| POST | `/api/freelancers/:id/contact` | Google account; start or reuse a conversation with `{ "text": "Hello" }` |
| GET | `/api/me/conversations?limit=24&cursor=` | Conversations containing the signed-in user |
| GET | `/api/me/conversations/:id/messages?limit=24&cursor=` | Members only; newest messages first |
| POST | `/api/me/conversations/:id/messages` | Members only; send `{ "text": "Hello" }` |

Freelancer profile updates require all fields: `displayName` (2-80 characters), `headline` (3-120), `location` (up to 120), `bio` (20-2000), `specialty` (`Portraits`, `Weddings`, `Events`, `Products`, `Fashion`, `Architecture`, or `Other`), `available` and `published` (booleans), and `instagram`, `facebook`, `tiktok`, `website` (HTTP/HTTPS URLs up to 500 characters or empty strings). Text is trimmed. Unknown fields are rejected; the verified user's ID determines profile ownership. Set `published` to false to hide a profile from public browsing.

Contact and reply requests return 201. Messages contain 1-3000 characters after trimming, and sender IDs come from the verified identity. Contact returns the conversation; replies return the new message. Repeated enquiries to the same photographer reuse the conversation and append a message. Self-contact returns 400, missing or unpublished photographers return 404, and unavailable photographers return 409. Existing conversation members can still reply after a profile becomes unavailable or unpublished. Reading or writing another user's conversation returns 403; missing conversations return 404.

Freelancer and conversation lists use ID order. Messages use descending creation time with ID as a tie-breaker. These endpoints return the same paginated envelope described below; message cursors must identify an existing message in that conversation. Contact and reply routes share a limit of 20 requests per minute per IP, in addition to the global API limit.

Upload multipart fields: `title` (3-120 characters), `description` (optional, up to 2000), `type` (`Image`, `PSD`, `Poster`, `Flyer`), `category`, `file`, and optional `preview`. Categories: Photography, Events, Business, People, Architecture, Education, Social Media, African Designs, Other. PNG, JPEG and WebP resources are supported up to 25 MB; PSD resources require an actual PSD file. Previews must be PNG/JPEG/WebP up to 5 MB; a separate preview is required for PSD and images larger than 5 MB. File signatures are checked; this is not malware scanning. HTML, SVG, ZIP, and arbitrary executable uploads are rejected.

List responses are `{ "items": [...], "nextCursor": "..." | null }`. Limits are 1-48. PostgreSQL filters case-insensitive substring searches across title, creator, type, category and description before pagination. Wildcard characters are treated literally. A large catalogue may benefit from a dedicated search index.

Like counts use a PostgreSQL transaction with per-user reaction rows, so retrying a request does not double-count. Download counts measure issued download links, not completed file transfers. Deleting a resource cascades to its likes and saves. Storage cleanup failures are logged with the resource ID and should be retried by an operator; use a reconciliation job at scale.

## Tests and production

```sh
npm test
npm run check
npm start
```

Tests execute the actual PostgreSQL migration and RPC using PGlite, with local substitutes for hosted Auth/Storage and HTTP transport. They cover authorization, private messaging, pagination, resource ownership, reactions, uploads and cleanup. They do not prove that your hosted project, Google OAuth credentials or deployment environment are configured correctly.

After configuring Supabase, smoke-test Google redirect login, token refresh, PNG and PSD uploads, previews, signed downloads, save/like, edits/deletes, profile publication, enquiries and replies using two accounts. Verify that non-members cannot read conversations. Deploy both repositories together and rebuild the frontend after changing its environment variables.

The API buffers uploads in memory (up to two 25 MB files per request); previews are limited to 5 MB. Rate limiting uses process memory; use a shared store with multiple instances. Storage cleanup failures are logged with resource IDs and require retry/reconciliation. There is no moderation queue or malware scanner. Search is database-side substring matching, so a large catalogue may need additional indexing. Hosting the Node API and Next.js frontend is separate from Supabase; monitor storage and bandwidth quotas as the library grows.

## Cutover from Firebase

This change migrates application code, not existing production accounts, records or files. It does not delete your Firebase project or modify its data. Keep the old deployment and a backup until Supabase passes the live checks.

For an empty project, apply the migration and start signing in/uploading through Supabase. Supabase assigns new user IDs. For an existing project, export data and files first and build a verified Firebase UID-to-Supabase user ID mapping; rewrite owner IDs, profiles, reactions, conversation members/names and message sender IDs, then copy private objects and preserve their paths or update resource references. Do not match or link accounts solely using unverified email input. Plan the populated-data import before switching production traffic; old Firebase sessions will require sign-in again.

The local `.env` was intentionally not overwritten. Replace its old Firebase settings with the Supabase settings from `.env.example`. Remove Firebase service-account secrets from hosting once the cutover is verified.

References: [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [server token validation](https://supabase.com/docs/reference/javascript/auth-getuser), [private signed downloads](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl), [database function privileges](https://supabase.com/docs/guides/database/functions).
