# AI Cinema Studio — Secure Setup

This version changes the app from a browser-only key-entry workflow into a private, same-origin Node.js app. Provider keys are kept on the server. You configure them once in `.env` when developing locally or in your hosting provider's private environment settings when deployed; you do not enter them for every video.

## Important design change

**Do not deploy only the `public/` folder to GitHub Pages.** GitHub Pages is a static host and cannot conceal provider credentials. This project serves the UI and private API from the same Node.js service, keeping API keys on the server and using authenticated media URLs. A public GitHub repository is okay only when it contains no real keys, passwords, or `.env` file.

## Run locally

Requires Node.js 22 or newer.

1. Copy `.env.example` to `.env`.
2. Set `APP_PASSWORD` to a long, unique password of at least 14 characters.
3. Generate a session secret by running:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   Paste the result into `SESSION_SECRET` in `.env`.
4. Put your real credentials in `.env`: `GEMINI_API_KEY`, `POLLINATIONS_API_KEY`, and optionally `HF_TOKEN` for Hugging Face Spaces that require it.
5. Install the packages and start the app:

   ```bash
   npm install
   npm start
   ```
6. Open `http://localhost:3000` and sign in with `APP_PASSWORD`.

Do not share `.env`. It is intentionally excluded by `.gitignore`.

## Deploy privately

Use a Node.js web host that supports persistent Node processes and long-running HTTP requests. Deploy the project root (not just `public/`). Set the build command to `npm install` and the start command to `npm start` if your host asks for them.

Add the following in the host's private **Environment Variables / Secrets** settings:

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `APP_ORIGIN` | Yes | Exact HTTPS origin of the deployed site, with no trailing slash, such as `https://your-app.example.com` |
| `APP_PASSWORD` | Yes | Long, unique workspace password (14+ characters) |
| `SESSION_SECRET` | Yes | Random secret at least 32 characters long; use a newly generated value |
| `GEMINI_API_KEY` | Yes | Google AI Studio key for prompt expansion |
| `POLLINATIONS_API_KEY` | Yes | Pollinations secret key for image and fallback video generation |
| `HF_TOKEN` | Optional | Hugging Face token for private/gated Spaces |
| `GEMINI_MODEL` | Optional | Defaults to `gemini-3.5-flash-lite` for faster prompt expansion |
| `GEMINI_TIMEOUT_MS` | Optional | Defaults to `25000`; allowed range is 10000–60000 ms |
| `PORT` | Usually supplied by host | Port used by the Node service |

After saving these values, restart/redeploy the service. The API credentials stay in the host's environment and are not added to the website or repository. Keep the deployment private and restrict access to its logs and environment settings.

## Protections included

- Password-protected access with a server-side session store.
- `HttpOnly`, `SameSite=Strict`, and production `Secure` session cookie.
- Same-origin checks plus a per-session CSRF token for state-changing routes.
- Login and generation rate limits; only one generation runs at a time.
- Content Security Policy and other security headers.
- Server-side provider requests; no API key text fields in the UI.
- Fixed server-owned model presets rather than browser-controlled remote endpoints or arbitrary Gradio payloads.
- Authenticated media routes, temporary media cache, file-size limits, provider-host allowlist for remote media, and request timeouts.
- No intentional logging of prompts or API credentials.

Generated assets are temporary: they expire after 45 minutes and are cleared when a new generation begins. The app currently uses in-memory sessions and assets and is intended for one private instance, not a multi-instance public service.

## Gemini timeout handling

The studio defaults to `gemini-3.5-flash-lite` for quick prompt expansion. If Gemini times out, the connection fails temporarily, the provider returns a server error, or no text is returned, the server builds a local cinematic prompt and continues to image/video generation instead of stopping at the first stage. Invalid credentials, denied model access, and exhausted quota still show a specific setup error; a fallback does not hide those configuration problems. You can adjust `GEMINI_TIMEOUT_MS` within 10–60 seconds in the private environment settings.

If you still see the old browser message `Gemini prompt expansion timed out after 45 seconds`, you are likely still running the older browser-only build. Deploy the **entire project root** from this ZIP to a Node.js host and open that deployed host's URL. Do not keep the old `app.js` on GitHub Pages, because that version sends API requests directly from the browser and does not use this secure backend.

## Provider compatibility note

The two Hugging Face presets preserve the Space IDs, endpoints, and payloads from the previous frontend. External Spaces can change their API schemas or become unavailable, and the app cannot guarantee either Space will continue to accept its saved payload. If the selected Space's `View API` schema changes, update the trusted preset files in `server/presets/` rather than exposing arbitrary endpoint/payload fields to every browser.

## Security limitations

No website can honestly be guaranteed “unhackable.” This version adds layered protections, but you should still use HTTPS, strong private credentials, spending limits, and current dependencies. If a real API key was ever committed to a public repository or exposed, revoke it at the provider and create a replacement. Do not remove authentication, origin checks, rate limits, or security headers simply to bypass a deployment error.
