# Setla backend

Node.js / Express API for the sibling `setla` Next.js website. Firebase Authentication verifies Google accounts, Firestore stores resources and user activity, and Cloud Storage holds private originals and previews.

## Set up Firebase

1. Create or select a Firebase project and register a Web app. Copy its web configuration into `setla/.env.local` using that repository's `.env.example`.
2. Under Authentication > Sign-in method, enable **Google**, select a support email, and add `localhost` and your production website domain under Authorized domains.
3. Create a Firestore database and a Cloud Storage bucket. Put the exact project ID and bucket name into this backend's `.env`.
4. For local development, generate a service-account private key under Project settings > Service accounts. Keep the JSON outside both repositories and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path. Never put server credentials into `NEXT_PUBLIC_*` variables or commit them. On Google Cloud, use an attached service account and Application Default Credentials instead; signed downloads require signing permissions (IAM Service Account Token Creator on the signing account) and the IAM Service Account Credentials API. The service account also needs Firebase Auth read access, Firestore data access, and Storage object access.
5. Deploy the supplied rules to your selected project using the Firebase CLI:

   ```sh
   firebase login
   firebase deploy --only firestore,storage --project YOUR_PROJECT_ID
   ```

   These rules deny direct browser database and bucket access. The Admin SDK accesses them through this API. Previews are public through the API; original downloads require a verified Google account.

## Run locally

Requires Node.js 22 or newer. From `setla-backend`:

```sh
npm ci
```

Copy `.env.example` to `.env`, fill in the Firebase values, then:

```sh
npm run dev
```

The API runs at `http://localhost:4000`; `GET /health` is a process liveness check (it does not verify Firebase connectivity). Start the sibling website separately with `npm run dev` and use `NEXT_PUBLIC_API_URL=http://localhost:4000` in its `.env.local`. Use the **same Firebase project** in both repositories. Sign in with Google, upload your first resource, then test saving, liking, downloading, and managing it under My uploads.

The gallery starts empty. The old frontend sample images are not seeded as real downloadable PSD/poster assets. Upload files you have permission to share.

## API

All endpoints return JSON except streamed previews and successful deletes. Protected endpoints accept `Authorization: Bearer <Firebase ID token>`; the frontend obtains and refreshes this token using the Firebase client SDK. No separate backend password or Google client secret is needed.

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

Freelancer profile updates require all fields: `displayName` (2–80 characters), `headline` (3–120), `location` (up to 120), `bio` (20–2000), `specialty` (`Portraits`, `Weddings`, `Events`, `Products`, `Fashion`, `Architecture`, or `Other`), `available` and `published` (booleans), and `instagram`, `facebook`, `tiktok`, `website` (HTTP/HTTPS URLs up to 500 characters or empty strings). Text is trimmed. Unknown fields are rejected; the verified user's ID determines profile ownership. Set `published` to false to hide a profile from public browsing.

Contact and reply requests return 201. Messages contain 1–3000 characters after trimming, and sender IDs come from the verified identity. Contact returns the conversation; replies return the new message. Repeated enquiries to the same photographer reuse the conversation and append a message. Self-contact returns 400, missing or unpublished photographers return 404, and unavailable photographers return 409. Existing conversation members can still reply after a profile becomes unavailable or unpublished. Reading or writing another user's conversation returns 403; missing conversations return 404.

Freelancer and conversation lists use document-ID order. Messages use descending creation time with document ID as a tie-breaker. These endpoints return the same paginated envelope described below; message cursors must identify an existing message in that conversation. Contact and reply routes share a limit of 20 requests per minute per IP, in addition to the global API limit.

Upload multipart fields: `title` (3–120 characters), `description` (optional, up to 2000), `type` (`Image`, `PSD`, `Poster`, `Flyer`), `category`, `file`, and optional `preview`. Categories: Photography, Events, Business, People, Architecture, Education, Social Media, African Designs, Other. PNG, JPEG and WebP resources are supported up to 25 MB; PSD resources require an actual PSD file. Previews must be PNG/JPEG/WebP up to 5 MB; a separate preview is required for PSD and images larger than 5 MB. File signatures are checked; this is not malware scanning. HTML, SVG, ZIP, and arbitrary executable uploads are rejected.

List responses are `{ "items": [...], "nextCursor": "..." | null }`. Limits are 1–48. Search scans at most 200 records per request; follow `nextCursor` even if a page is empty. It searches title, creator, type, category, and description using a case-insensitive substring. At larger scale, use a dedicated search index. Built-in Firestore single-field indexes cover these queries.

Like counts use a transaction with per-user reaction documents, so retrying a request does not double-count. Download counts measure issued download links, not completed file transfers. Deleted-resource activity references are harmless and skipped by saved-resource listing. Storage cleanup failures are logged with the resource ID and should be retried by an operator; use a reconciliation job at scale.

## Tests and production

```sh
npm test
npm run check
npm start
```

Tests exercise HTTP validation and the repository's authorization / reaction logic using in-memory Firebase doubles; they do not contact a live Firebase project. Verify Google popup login, actual bucket access, signed downloads, and Firestore transactions against your configured project before release.

Deploy the Node service with environment secrets and HTTPS, set `FRONTEND_ORIGINS` to a comma-separated list of exact allowed website origins, and rebuild the frontend with the deployed API URL. `TRUST_PROXY` defaults to 0; configure it to match your actual proxy topology. Rate limiting uses local memory; use a shared store when running multiple instances. Uploads are buffered in memory (maximum two 25 MB files per request); provision memory and request limits accordingly. The API has no moderation queue or malware scanner.

Implementation references: [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin), [server ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), and [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions).
