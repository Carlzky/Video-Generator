# Security Notes

## Credential handling

- Keep real API keys only in `.env` for local work or in the hosting provider's private environment/secrets settings.
- Never put provider keys in `public/`, frontend JavaScript, HTML, query strings sent to the browser, issue reports, or a public repository.
- If any real key was committed or pasted into a public location, revoke it at the provider and create a replacement.
- The app never returns API keys through an API route and does not write prompts or credentials to application logs intentionally.

## Access controls

- The app uses a long workspace password, signed opaque session cookie (`HttpOnly`, `SameSite=Strict`, and `Secure` in production), an in-memory session store, a CSRF token, same-origin checks, login rate limiting, and generation rate limiting.
- Media routes require an authenticated session. Generated media is temporary and expires after 45 minutes or when a new generation begins.
- The service is intended for one private instance. Do not add public users or deploy multiple instances without a shared session store, persistent rate limiting, and per-user quotas.

## Deployment

- Set `NODE_ENV=production` and `APP_ORIGIN` to the exact HTTPS origin.
- Use a private deployment and a single-origin host. Do not deploy only `public/` to GitHub Pages; a static site cannot keep API keys secret.
- Keep the service on HTTPS. Do not disable the content security policy or origin/CSRF checks to work around deployment problems.
- Apply provider spending limits and monitor usage. Rotate provider keys if you suspect exposure.

Security is layered, not absolute; no website can be guaranteed unhackable. Keep dependencies current and monitor provider/account activity.
