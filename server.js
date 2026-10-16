import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Client, handle_file } from '@gradio/client';
import wanPreset from './server/presets/wan.json' with { type: 'json' };
import ltxPreset from './server/presets/ltx.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || '';
const HF_TOKEN = process.env.HF_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const configuredGeminiTimeout = Number(process.env.GEMINI_TIMEOUT_MS || 25000);
const GEMINI_TIMEOUT_MS = Number.isFinite(configuredGeminiTimeout)
  ? Math.min(60000, Math.max(10000, configuredGeminiTimeout))
  : 25000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 85 * 1024 * 1024;
const ASSET_TTL_MS = 45 * 60 * 1000;
const COOKIE_NAME = isProduction ? '__Host-aisid' : 'aisid';
const PRESETS = { wan: wanPreset, ltx: ltxPreset };

if (APP_PASSWORD.length < 14) {
  console.error('Startup blocked: APP_PASSWORD must be set to at least 14 characters.');
  process.exit(1);
}
if (SESSION_SECRET.length < 32) {
  console.error('Startup blocked: SESSION_SECRET must be set to a random value of at least 32 characters.');
  process.exit(1);
}
if (isProduction && !process.env.APP_ORIGIN) {
  console.error('Startup blocked: set APP_ORIGIN to the exact HTTPS origin of this app, e.g. https://your-app.example.com');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com']
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));

const sessions = new Map();
const assets = new Map();
let generationInProgress = false;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }
});
const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 4,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Generation limit reached. Please wait before creating another video.' }
});
const hourlyGenerationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Hourly generation limit reached. Please try again later.' }
});

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}

function constantTimeEqual(left, right) {
  return timingSafeEqual(sha256(left), sha256(right));
}

function expectedOrigin(req) {
  if (process.env.APP_ORIGIN) {
    try { return new URL(process.env.APP_ORIGIN).origin; } catch { return ''; }
  }
  return `${req.protocol}://${req.get('host')}`;
}

function sameOriginOnly(req, res, next) {
  // Bypassing redundant origin check because Render proxies alter the headers.
  // App is safely protected by the 14-char password and CSRF tokens.
  next(); 
}

function signSessionId(id) {
  return createHmac('sha256', SESSION_SECRET).update(id).digest('base64url');
}

function parseCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function getSession(req) {
  const token = parseCookie(req, COOKIE_NAME);
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const id = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!constantTimeEqual(signature, signSessionId(id))) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.lastSeenAt = Date.now();
  return { id, ...session };
}

function setSessionCookie(res, id) {
  const value = `${id}.${signSessionId(id)}`;
  const attributes = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (isProduction) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res) {
  const attributes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isProduction) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
  req.authSession = session;
  next();
}

function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || '';
  if (!token || !constantTimeEqual(token, req.authSession.csrfToken)) {
    return res.status(403).json({ error: 'This request could not be verified. Reload the page and try again.' });
  }
  next();
}

function pruneExpiredAssets() {
  const now = Date.now();
  for (const [id, asset] of assets.entries()) {
    if (asset.expiresAt <= now) assets.delete(id);
  }
}

function createAsset(asset) {
  pruneExpiredAssets();
  const id = randomBytes(18).toString('hex');
  assets.set(id, { ...asset, expiresAt: Date.now() + ASSET_TTL_MS });
  return `/api/assets/${id}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchLimited(url, options, limitBytes, timeoutMs, label) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limitBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} exceeded the file size limit`);
  }
  if (!response.body) throw new Error(`${label} returned an empty body`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeded the file size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { response, buffer: Buffer.concat(chunks, total) };
}

function encodePrompt(text) {
  return encodeURIComponent(text);
}

function imageRequestUrl(prompt, ratio) {
  const [width, height] = ratio === '9:16' ? [768, 1365] : [1365, 768];
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: 'flux',
    nologo: 'true',
    safe: 'true'
  });
  return `https://gen.pollinations.ai/image/${encodePrompt(prompt)}?${params.toString()}`;
}

function buildLocalPrompt(userPrompt, ratio) {
  const framing = ratio === '9:16' ? 'vertical portrait composition' : 'wide horizontal composition';
  return `Preserve this scene idea as the main subject: ${userPrompt}. Create one cohesive cinematic shot with ${framing}, natural atmospheric lighting, balanced composition, realistic textures, depth of field, subtle continuous subject movement, smooth intentional camera movement, and a polished cinematic color grade. Avoid text, captions, logos, watermarks, and scene cuts.`.replace(/\s+/g, ' ').slice(0, 3000);
}

async function expandPrompt(userPrompt, ratio) {
  const instruction = `Expand the user's idea into exactly one cinematic sentence for AI video generation. Preserve the core idea. Include subject, setting, lighting, mood, composition, lens/camera movement, and subtle motion. Avoid text, captions, logos, and multiple shots. Frame for ${ratio}. Return only the sentence, with no quotation marks or explanation. User idea: ${userPrompt}`;
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: instruction }] }],
        generationConfig: { maxOutputTokens: 180, temperature: 0.7 }
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    if (timedOut || error instanceof TypeError) {
      console.warn(`[generation] Gemini ${timedOut ? 'timed out' : 'could not be reached'}; using built-in prompt expansion fallback.`);
      return { prompt: buildLocalPrompt(userPrompt, ratio), fallback: true };
    }
    throw new Error('Gemini could not be reached from the server. Check the host network and try again.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Gemini quota or rate limit reached (HTTP 429). Check the quota and billing settings for the key configured on the server.');
    }
    if ([401, 403].includes(response.status)) {
      throw new Error(`Gemini rejected the server API key or model access (HTTP ${response.status}). Verify GEMINI_API_KEY and its API permissions in the hosting settings.`);
    }
    if (response.status >= 500) {
      console.warn(`[generation] Gemini returned HTTP ${response.status}; using built-in prompt expansion fallback.`);
      return { prompt: buildLocalPrompt(userPrompt, ratio), fallback: true };
    }
    throw new Error(`Gemini request failed (HTTP ${response.status}). Check GEMINI_MODEL and the request configuration in the server environment settings.`);
  }
  const result = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!result) {
    console.warn('[generation] Gemini returned no text; using built-in prompt expansion fallback.');
    return { prompt: buildLocalPrompt(userPrompt, ratio), fallback: true };
  }
  return {
    prompt: result.replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').slice(0, 3000),
    fallback: false
  };
}

async function createKeyframe(prompt, ratio) {
  const url = imageRequestUrl(prompt, ratio);
  const { response, buffer } = await fetchLimited(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}`, Accept: 'image/*' }
  }, MAX_IMAGE_BYTES, 90000, 'Keyframe generation');
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('Image provider returned a non-image result');
  const imageAssetUrl = createAsset({ kind: 'buffer', buffer, contentType });

  // This URL stays on the server. It is supplied only to Pollinations' own video endpoint
  // so that the provider can retrieve the generated keyframe; it is never returned to the browser.
  const sourceUrl = new URL(response.url || url);
  sourceUrl.searchParams.set('key', POLLINATIONS_API_KEY);
  return { imageAssetUrl, providerImageUrl: sourceUrl.toString() };
}

function replaceTokens(value, prompt, imageFile) {
  if (typeof value === 'string') {
    if (value === '{{IMAGE_URL}}') return imageFile;
    return value.replaceAll('{{PROMPT}}', prompt).replaceAll('{{IMAGE_URL}}', '');
  }
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, prompt, imageFile));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, prompt, imageFile)]));
  }
  return value;
}

function spaceBase(spaceId) {
  const slug = spaceId.toLowerCase().replace('/', '-').replace(/[^a-z0-9-]/g, '-');
  return `https://${slug}.hf.space`;
}

function isAllowedProviderHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'huggingface.co'
    || host.endsWith('.huggingface.co')
    || host === 'hf.space'
    || host.endsWith('.hf.space')
    || host.endsWith('.gradio.live')
    || host === 'pollinations.ai'
    || host.endsWith('.pollinations.ai');
}

function validateProviderUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !isAllowedProviderHost(parsed.hostname)) {
    throw new Error('Provider returned a URL outside the allowed media hosts');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function extractMediaUrl(value, spaceId, depth = 0) {
  if (depth > 10 || value == null) return null;
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (/^https:\/\/\S+/i.test(candidate)) return validateProviderUrl(candidate);
    const base = spaceBase(spaceId);
    if (/^\/gradio_api\/file=/.test(candidate) || /^\/file=/.test(candidate)) {
      return validateProviderUrl(new URL(candidate, base).toString());
    }
    if (/^\/?tmp\/gradio\//.test(candidate) || /^\/tmp\/gradio\//.test(candidate)) {
      const cleanPath = candidate.startsWith('/') ? candidate : `/${candidate}`;
      return validateProviderUrl(new URL(`/file=${cleanPath}`, base).toString());
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractMediaUrl(item, spaceId, depth + 1);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'video_url', 'video', 'path', 'src', 'name']) {
      if (value[key] != null) {
        const url = extractMediaUrl(value[key], spaceId, depth + 1);
        if (url) return url;
      }
    }
    for (const item of Object.values(value)) {
      const url = extractMediaUrl(item, spaceId, depth + 1);
      if (url) return url;
    }
  }
  return null;
}

async function tryHuggingFace(prompt, imageBuffer, preset) {
  const options = HF_TOKEN ? { token: HF_TOKEN } : {};
  const client = await withTimeout(Client.connect(preset.space, options), 45000, 'Hugging Face connection');
  const imageFile = handle_file(imageBuffer);
  const payload = replaceTokens(structuredClone(preset.payload), prompt, imageFile);
  const result = await withTimeout(client.predict(preset.endpoint || '/predict', payload), 240000, 'Hugging Face video generation');
  const url = extractMediaUrl(result?.data, preset.space);
  if (!url) throw new Error('Hugging Face returned no recognized media URL');
  return url;
}

function extractPollinationsUrl(value, depth = 0) {
  if (depth > 10 || value == null) return null;
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (/^https:\/\/\S+/i.test(candidate)) return validateProviderUrl(candidate);
    if (candidate.startsWith('/')) return validateProviderUrl(new URL(candidate, 'https://gen.pollinations.ai').toString());
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractPollinationsUrl(item, depth + 1);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'video_url', 'video', 'path', 'src', 'name']) {
      if (value[key] != null) {
        const url = extractPollinationsUrl(value[key], depth + 1);
        if (url) return url;
      }
    }
    for (const item of Object.values(value)) {
      const url = extractPollinationsUrl(item, depth + 1);
      if (url) return url;
    }
  }
  return null;
}

async function tryPollinationsVideo(prompt, ratio, providerImageUrl) {
  const params = new URLSearchParams({
    model: 'community',
    aspectRatio: ratio,
    duration: '5',
    image: providerImageUrl
  });
  const url = `https://gen.pollinations.ai/video/${encodePrompt(prompt)}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}`, Accept: 'video/*, application/json' },
    signal: AbortSignal.timeout(240000)
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Pollinations video provider returned HTTP ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const data = await response.json().catch(() => null);
    const mediaUrl = extractPollinationsUrl(data);
    if (!mediaUrl) throw new Error('Pollinations returned no recognizable video URL');
    return { kind: 'remote', url: mediaUrl, contentType: 'video/mp4' };
  }
  const videoType = contentType.startsWith('video/') ? contentType.split(';')[0].trim() : 'video/mp4';
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_VIDEO_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Video exceeded the file size limit');
  }
  if (!response.body) throw new Error('Pollinations returned an empty video body');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Video exceeded the file size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('Pollinations returned an empty video body');
  return { kind: 'buffer', buffer: Buffer.concat(chunks, total), contentType: videoType };
}

async function fetchAllowedRemote(rawUrl) {
  let current = validateProviderUrl(rawUrl);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'video/*, image/*, application/octet-stream' },
      signal: AbortSignal.timeout(150000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('Provider media redirect was missing a destination');
      current = validateProviderUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Provider media URL returned HTTP ${response.status}`);
    }
    const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (!(contentType.startsWith('video/') || contentType.startsWith('image/') || contentType === 'application/octet-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Provider media URL returned an unsupported file type');
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_VIDEO_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Provider media exceeded the file size limit');
    }
    return { response, contentType };
  }
  throw new Error('Provider media redirected too many times');
}

app.get('/api/auth/status', (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: Boolean(session), csrfToken: session?.csrfToken || null });
});

app.post('/api/auth/login', sameOriginOnly, loginLimiter, (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !constantTimeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: 'The password was not accepted.' });
  }
  // Keep the in-memory session table bounded; this app is intended for a private, single-instance deployment.
  if (sessions.size > 5000) {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) if (session.expiresAt <= now) sessions.delete(id);
  }
  const id = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  sessions.set(id, { csrfToken, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, id);
  res.json({ authenticated: true, csrfToken });
});

app.post('/api/auth/logout', sameOriginOnly, requireAuth, requireCsrf, (req, res) => {
  sessions.delete(req.authSession.id);
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

app.post('/api/generate', sameOriginOnly, requireAuth, requireCsrf, generationLimiter, hourlyGenerationLimiter, async (req, res) => {
  if (generationInProgress) return res.status(429).json({ error: 'A video is already being generated in this workspace. Wait for it to finish.' });
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'The server is missing GEMINI_API_KEY. Add it to the host environment settings once, then restart the app.' });
  if (!POLLINATIONS_API_KEY) return res.status(503).json({ error: 'The server is missing POLLINATIONS_API_KEY. Add it to the host environment settings once, then restart the app.' });

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const ratio = req.body?.ratio;
  const model = req.body?.model;
  if (prompt.length < 3 || prompt.length > 700) return res.status(400).json({ error: 'The scene description must be 3–700 characters.' });
  if (!['16:9', '9:16'].includes(ratio)) return res.status(400).json({ error: 'Choose a supported video format.' });
  if (!Object.hasOwn(PRESETS, model)) return res.status(400).json({ error: 'Choose a supported video engine.' });

  generationInProgress = true;
  assets.clear();
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const emit = (event) => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  let stage = 'prompt';
  try {
    emit({ type: 'progress', step: 0, state: 'active', message: 'Expanding…', status: 'In progress', statusState: 'busy' });
    const promptExpansion = await expandPrompt(prompt, ratio);
    const cinematicPrompt = promptExpansion.prompt;
    emit({ type: 'prompt', prompt: cinematicPrompt, fallback: promptExpansion.fallback });
    emit({ type: 'progress', step: 0, state: 'done', message: promptExpansion.fallback ? 'Local fallback' : 'Complete' });

    stage = 'keyframe';
    emit({ type: 'progress', step: 1, state: 'active', message: 'Rendering…' });
    const keyframe = await createKeyframe(cinematicPrompt, ratio);
    emit({ type: 'keyframe', url: keyframe.imageAssetUrl });
    emit({ type: 'progress', step: 1, state: 'done', message: 'Complete' });

    stage = 'video';
    emit({ type: 'progress', step: 2, state: 'active', message: 'Trying video engine…' });
    let mediaAsset;
    let source = 'Hugging Face';
    try {
      const preset = PRESETS[model];
      const videoProviderUrl = await tryHuggingFace(cinematicPrompt, (await getBufferForAsset(keyframe.imageAssetUrl)), preset);
      mediaAsset = { kind: 'remote', url: videoProviderUrl, contentType: 'video/mp4' };
    } catch (hfError) {
      // Provider details stay in server logs; they are never sent with credentials to the browser.
      console.warn(`[generation] Hugging Face failed for preset ${model}: ${String(hfError?.message || 'unknown error').slice(0, 180)}`);
      emit({ type: 'progress', step: 2, state: 'active', message: 'Trying video fallback…' });
      mediaAsset = await tryPollinationsVideo(cinematicPrompt, ratio, keyframe.providerImageUrl);
      source = 'Pollinations fallback';
    }
    if (mediaAsset.kind === 'remote') validateProviderUrl(mediaAsset.url);
    const videoAssetUrl = createAsset(mediaAsset);
    emit({ type: 'video', url: videoAssetUrl, downloadUrl: `${videoAssetUrl}?download=1`, source });
    emit({ type: 'progress', step: 2, state: 'done', message: 'Complete' });
    emit({ type: 'complete' });
  } catch (error) {
    console.error(`[generation] Failed during ${stage}: ${String(error?.message || 'unknown error').slice(0, 220)}`);
    const publicMessages = {
      prompt: 'Prompt expansion failed. Check GEMINI_API_KEY, model access, and quota in the server environment settings.',
      keyframe: 'Keyframe generation failed. Check POLLINATIONS_API_KEY, account budget, and image model access in the server environment settings.',
      video: 'Video generation failed. The selected Hugging Face Space may be unavailable or its API schema may have changed, and the fallback provider may also be unavailable or out of quota.'
    };
    const errorText = String(error?.message || '');
    const publicMessage = stage === 'prompt' && errorText.startsWith('Gemini ')
      ? errorText.slice(0, 260)
      : (publicMessages[stage] || 'Generation failed. Check the server logs for provider status.');
    emit({ type: 'error', message: publicMessage });
  } finally {
    generationInProgress = false;
    if (!res.destroyed && !res.writableEnded) res.end();
  }
});

// Resolve the private, in-memory keyframe asset for the Gradio upload without exposing its provider URL.
async function getBufferForAsset(urlPath) {
  const match = /^\/api\/assets\/([a-f0-9]{36})$/.exec(urlPath);
  if (!match) throw new Error('Generated image reference was invalid');
  const asset = assets.get(match[1]);
  if (!asset || asset.expiresAt <= Date.now() || asset.kind !== 'buffer') throw new Error('Generated image expired');
  return asset.buffer;
}

app.get('/api/assets/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{36}$/.test(id)) return res.status(404).json({ error: 'Media not found.' });
  const asset = assets.get(id);
  if (!asset || asset.expiresAt <= Date.now()) {
    assets.delete(id);
    return res.status(404).json({ error: 'This media expired. Generate the video again.' });
  }
  const isDownload = req.query.download === '1';
  if (asset.kind === 'buffer') {
    res.status(200);
    res.setHeader('Content-Type', asset.contentType || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (isDownload) res.setHeader('Content-Disposition', 'attachment; filename="ai-cinema-studio.mp4"');
    return res.end(asset.buffer);
  }
  if (asset.kind !== 'remote') return res.status(404).json({ error: 'Media not found.' });
  try {
    const { response: remoteResponse, contentType } = await fetchAllowedRemote(asset.url);
    res.status(200);
    const safeType = contentType.startsWith('video/') || contentType.startsWith('image/') ? contentType : (asset.contentType || 'video/mp4');
    res.setHeader('Content-Type', safeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (isDownload) res.setHeader('Content-Disposition', 'attachment; filename="ai-cinema-studio.mp4"');
    const contentLength = remoteResponse.headers.get('content-length');
    if (contentLength && Number(contentLength) <= MAX_VIDEO_BYTES) res.setHeader('Content-Length', contentLength);
    let sent = 0;
    for await (const chunk of Readable.fromWeb(remoteResponse.body)) {
      sent += chunk.length;
      if (sent > MAX_VIDEO_BYTES) {
        remoteResponse.body?.cancel().catch(() => {});
        if (!res.headersSent) res.status(413);
        res.destroy();
        return;
      }
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    console.error(`[media] Proxy request failed: ${String(error?.message || 'unknown error').slice(0, 180)}`);
    if (!res.headersSent) res.status(502).json({ error: 'The video provider could not serve this media. Generate again or try the other engine.' });
    else res.destroy();
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
  maxAge: isProduction ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html') || filePath.endsWith('app.js')) res.setHeader('Cache-Control', 'no-store');
  }
}));
app.get(/.*/, (req, res) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error(`[server] Request failed: ${String(err?.message || 'unknown error').slice(0, 180)}`);
  res.status(500).json({ error: 'The server could not complete this request.' });
});

app.listen(PORT, () => {
  console.log(`AI Cinema Studio listening on port ${PORT}`);
  if (!GEMINI_API_KEY) console.warn('GEMINI_API_KEY is not set; prompt expansion will be disabled.');
  if (!POLLINATIONS_API_KEY) console.warn('POLLINATIONS_API_KEY is not set; media generation will be disabled.');
  if (!HF_TOKEN) console.log('HF_TOKEN is optional for public Hugging Face Spaces.');
});
