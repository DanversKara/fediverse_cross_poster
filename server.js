const dns = require('dns');
const net = require('net');
const express = require('express');
const path = require('path');
const multer = require('multer');
const { imageSize } = require('image-size');
const { optimizeImageForLimits, optimizeVideoForLimits } = require('./mediaOptimizer');

// Node (from v18+) tries a host's IPv4 and IPv6 addresses in parallel
// ("happy eyeballs") and picks whichever connects first. Inside a lot of
// Docker setups there's no real outbound IPv6 route — every IPv6 attempt
// fails/times out immediately, and a known Node bug means that fast failure
// doesn't reliably trigger the IPv4 fallback in time, so the otherwise-fine
// IPv4 connection stalls until it also times out (nodejs/node#48822).
//
// dns.setDefaultResultOrder only changes which address DNS returns first —
// it does NOT stop Node from racing both families. The actual fix is to
// disable the race entirely so Node just uses the first resolved address.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;

// Node's fetch throws a bare "fetch failed" TypeError for any network-level
// failure (DNS lookup, connection refused, TLS handshake, timeout, etc.) —
// the actually-useful reason lives one level down in `error.cause`, and for
// dual-stack connection failures `cause` is itself an AggregateError whose
// real per-address errors are hiding in `cause.errors` — one level deeper
// still. This unwraps all of that instead of dropping it.
async function fetchWithContext(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    let detail = e.message;
    const cause = e.cause;
    if (cause) {
      if (Array.isArray(cause.errors)) {
        // AggregateError from a dual-stack (IPv4 + IPv6) connect attempt —
        // one sub-error per address it tried.
        const attempts = cause.errors.map((err) => {
          const addr = err.address ? `${err.address}:${err.port || ''}` : '';
          return `${err.code || err.message}${addr ? ` (${addr})` : ''}`;
        });
        detail += `: ${attempts.join(', ')}`;
      } else {
        detail += `: ${cause.code || ''} ${cause.message || cause}`.trim();
      }
    }
    throw new Error(`Request to ${url} failed: ${detail}`);
  }
}

const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE || '';
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD || '';
const BLUESKY_SERVICE = process.env.BLUESKY_SERVICE || 'https://bsky.social';

const MASTODON_INSTANCE_URL = (process.env.MASTODON_INSTANCE_URL || 'https://social.chiefgyk3d.com').replace(/\/+$/, '');
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN || '';

// ---- Media constraints ----
// Bluesky limits are fixed by the AT Protocol lexicon / current Bluesky video service.
// Sources: app.bsky.embed.images (maxSize 2,000,000 bytes, maxLength 4) and the
// Bluesky video announcement (100MB, 3min, mp4/mpeg/webm/mov, one video OR up to 4 images).
const BLUESKY_LIMITS = {
  maxImages: 4,
  imageMaxBytes: 2_000_000, // 2 MB
  imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  videoMaxBytes: 100_000_000, // 100 MB
  videoMaxDurationSec: 180, // 3 minutes (not verified server-side, no ffprobe available)
  videoMimeTypes: ['video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime'],
};

// Mastodon limits vary per-instance. We ask the instance for its actual configured
// limits (GET /api/v2/instance) and fall back to vanilla Mastodon defaults if that
// fails or the instance is older and doesn't expose it.
const MASTODON_DEFAULT_LIMITS = {
  maxImages: 4, // vanilla Mastodon's built-in cap on non-poll attachments
  imageMaxBytes: 10_000_000, // 10 MB (default Mastodon config)
  videoMaxBytes: 40_000_000, // 40 MB (default Mastodon config)
  imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif'],
  videoMimeTypes: ['video/webm', 'video/mp4', 'video/quicktime', 'video/ogg'],
  videoMaxDurationSec: null, // not exposed by the Mastodon instance API
};

let mastodonLimitsCache = { value: null, fetchedAt: 0 };
const MASTODON_LIMITS_TTL_MS = 5 * 60 * 1000;

async function getMastodonLimits() {
  if (!MASTODON_INSTANCE_URL) return MASTODON_DEFAULT_LIMITS;

  const now = Date.now();
  if (mastodonLimitsCache.value && now - mastodonLimitsCache.fetchedAt < MASTODON_LIMITS_TTL_MS) {
    return mastodonLimitsCache.value;
  }

  try {
    const res = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v2/instance`);
    if (!res.ok) throw new Error(`instance config fetch failed: ${res.status}`);
    const data = await res.json();
    const ma = data?.configuration?.media_attachments;
    const st = data?.configuration?.statuses;
    const mimeTypes = ma?.supported_mime_types || MASTODON_DEFAULT_LIMITS.imageMimeTypes.concat(MASTODON_DEFAULT_LIMITS.videoMimeTypes);
    const limits = {
      maxImages: st?.max_media_attachments || MASTODON_DEFAULT_LIMITS.maxImages,
      imageMaxBytes: ma?.image_size_limit || MASTODON_DEFAULT_LIMITS.imageMaxBytes,
      videoMaxBytes: ma?.video_size_limit || MASTODON_DEFAULT_LIMITS.videoMaxBytes,
      imageMimeTypes: mimeTypes.filter((m) => m.startsWith('image/')),
      videoMimeTypes: mimeTypes.filter((m) => m.startsWith('video/')),
      videoMaxDurationSec: null,
    };
    mastodonLimitsCache = { value: limits, fetchedAt: now };
    return limits;
  } catch (e) {
    // Instance unreachable or too old to expose config — fall back to safe defaults
    // rather than blocking the whole feature.
    return MASTODON_DEFAULT_LIMITS;
  }
}

// Combine limits for exactly the platforms the person actually has selected.
// If they've unchecked Bluesky, a file only needs to satisfy Mastodon's limits
// (and vice versa) — only intersect across platforms that are both selected
// AND configured, since an unconfigured/unselected platform never receives the file.
async function getLimitsForTargets(targets) {
  const wantBluesky = targets.includes('bluesky') && Boolean(BLUESKY_HANDLE && BLUESKY_APP_PASSWORD);
  const wantMastodon = targets.includes('mastodon') && Boolean(MASTODON_ACCESS_TOKEN);

  const active = [];
  if (wantBluesky) active.push(BLUESKY_LIMITS);
  if (wantMastodon) active.push(await getMastodonLimits());

  if (active.length === 0) {
    // Nothing configured/selected — fall back to Bluesky's shape so the caller
    // still gets sane numbers (postToX will raise the real "not configured" error).
    active.push(BLUESKY_LIMITS);
  }

  const intersect = (lists) => lists.reduce((acc, l) => (acc ? acc.filter((m) => l.includes(m)) : l), null);
  const minOf = (nums) => {
    const defined = nums.filter((n) => n !== null && n !== undefined);
    return defined.length ? Math.min(...defined) : null;
  };

  return {
    maxImages: minOf(active.map((l) => l.maxImages)),
    imageMaxBytes: minOf(active.map((l) => l.imageMaxBytes)),
    imageMimeTypes: intersect(active.map((l) => l.imageMimeTypes)),
    videoMaxBytes: minOf(active.map((l) => l.videoMaxBytes)),
    videoMaxDurationSec: minOf(active.map((l) => l.videoMaxDurationSec)),
    videoMimeTypes: intersect(active.map((l) => l.videoMimeTypes)),
  };
}

// Validate the uploaded files' basic shape against the rules of whichever
// platforms are actually selected for this post. Returns
// { images: [file...], video: file|null }. Throws with a user-facing message
// on violations that a re-encode can't fix (wrong file category entirely, or
// too many files). Format and byte-size limits are NOT enforced here — the
// background editor (optimizeMediaForTarget, below) brings each file into
// spec for each target platform right before it's sent, instead of rejecting
// the upload outright.
async function validateMedia(files, targets) {
  if (!files || files.length === 0) return { images: [], video: null };

  const limits = await getLimitsForTargets(targets);
  const platformNote = targets.length > 1 ? 'both selected platforms' : `${targets[0]}`;

  const images = files.filter((f) => f.mimetype.startsWith('image/'));
  const videos = files.filter((f) => f.mimetype.startsWith('video/'));
  const other = files.filter((f) => !f.mimetype.startsWith('image/') && !f.mimetype.startsWith('video/'));

  if (other.length > 0) {
    throw new Error(`Unsupported file type: ${other[0].originalname} (${other[0].mimetype}).`);
  }

  // Neither platform allows mixing a video with images in the same post.
  if (images.length > 0 && videos.length > 0) {
    throw new Error('You can attach either images or one video, not both, in a single post (Bluesky and Mastodon both disallow mixing).');
  }

  if (videos.length > 1) {
    throw new Error('Only one video is allowed per post.');
  }

  if (videos.length === 1) {
    return { images: [], video: videos[0] };
  }

  // The editor re-encodes/shrinks files, but it won't silently drop photos
  // you chose to attach — too many images is still a hard stop.
  if (images.length > limits.maxImages) {
    throw new Error(`Up to ${limits.maxImages} images are allowed per post on ${platformNote}.`);
  }

  return { images, video: null };
}

// Runs the background editor over each attached file so it fits ONE target
// platform's real limits — resizing/recompressing images, and
// re-encoding/trimming video as needed. Called once per selected platform
// (with that platform's own limits) so Bluesky and Mastodon each get a copy
// tailored to their own requirements, even when those requirements differ.
// Files that already fit are passed through untouched (see the fast paths in
// mediaOptimizer.js), so this is cheap when no editing is actually needed.
async function optimizeMediaForTarget(media, limits) {
  if (media.video) {
    const optimized = await optimizeVideoForLimits(media.video.buffer, media.video.mimetype, media.video.originalname, limits);
    return {
      images: [],
      video: { ...media.video, buffer: optimized.buffer, mimetype: optimized.mimetype, size: optimized.buffer.length },
    };
  }

  if (media.images.length > 0) {
    const images = await Promise.all(media.images.map(async (img) => {
      const optimized = await optimizeImageForLimits(img.buffer, img.mimetype, limits);
      return { ...img, buffer: optimized.buffer, mimetype: optimized.mimetype, size: optimized.buffer.length };
    }));
    return { images, video: null };
  }

  return media;
}

function safeAspectRatio(buffer) {
  try {
    const dims = imageSize(buffer);
    if (dims?.width && dims?.height) {
      return { width: dims.width, height: dims.height };
    }
  } catch (e) {
    // Not fatal — aspectRatio is optional on both platforms' embeds.
  }
  return undefined;
}

// ---- Bluesky (AT Protocol) ----
async function blueskyLogin() {
  const sessionRes = await fetchWithContext(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD })
  });
  if (!sessionRes.ok) {
    const err = await sessionRes.text();
    throw new Error(`Bluesky login failed: ${sessionRes.status} ${err}`);
  }
  return sessionRes.json();
}

async function blueskyUploadBlob(session, file) {
  const res = await fetchWithContext(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'Content-Type': file.mimetype,
      Authorization: `Bearer ${session.accessJwt}`
    },
    body: file.buffer
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky media upload failed for ${file.originalname}: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.blob;
}

async function postToBluesky(text, media, altTexts) {
  if (!BLUESKY_HANDLE || !BLUESKY_APP_PASSWORD) {
    throw new Error('Bluesky credentials not configured (BLUESKY_HANDLE / BLUESKY_APP_PASSWORD).');
  }

  const session = await blueskyLogin();

  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString()
  };

  if (media.video) {
    const blob = await blueskyUploadBlob(session, media.video);
    record.embed = {
      $type: 'app.bsky.embed.video',
      video: blob,
      alt: (altTexts && altTexts[0]) || undefined,
    };
  } else if (media.images.length > 0) {
    const images = [];
    for (let i = 0; i < media.images.length; i++) {
      const file = media.images[i];
      const blob = await blueskyUploadBlob(session, file);
      images.push({
        image: blob,
        alt: (altTexts && altTexts[i]) || '',
        aspectRatio: safeAspectRatio(file.buffer),
      });
    }
    record.embed = { $type: 'app.bsky.embed.images', images };
  }

  const postRes = await fetchWithContext(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record
    })
  });

  if (!postRes.ok) {
    const err = await postRes.text();
    throw new Error(`Bluesky post failed: ${postRes.status} ${err}`);
  }

  const data = await postRes.json();
  return { uri: data.uri, cid: data.cid };
}

// ---- Mastodon ----
async function mastodonUploadMedia(file, description) {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  if (description) form.append('description', description);

  const res = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v2/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` },
    body: form
  });

  if (!res.ok && res.status !== 202) {
    const err = await res.text();
    throw new Error(`Mastodon media upload failed for ${file.originalname}: ${res.status} ${err}`);
  }

  let media = await res.json();

  // Video/gif processing can be async: 202 (or a 200 with no url yet) means Mastodon
  // is still transcoding. Poll until it's ready or give up after ~30s.
  const attachmentId = media.id;
  let attempts = 0;
  while (!media.url && attempts < 15) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v1/media/${attachmentId}`, {
      headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` }
    });
    if (pollRes.status === 200) {
      media = await pollRes.json();
      break;
    }
    // 206 = still processing
    attempts++;
  }

  return attachmentId;
}

async function postToMastodon(text, media, altTexts) {
  if (!MASTODON_ACCESS_TOKEN) {
    throw new Error('Mastodon access token not configured (MASTODON_ACCESS_TOKEN).');
  }

  const files = media.video ? [media.video] : media.images;
  const mediaIds = [];
  for (let i = 0; i < files.length; i++) {
    const id = await mastodonUploadMedia(files[i], altTexts && altTexts[i]);
    mediaIds.push(id);
  }

  const res = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ status: text, visibility: 'public', media_ids: mediaIds })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mastodon post failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return { url: data.url, id: data.id };
}

// ---- Uploads ----
// This cap is just a sane upper bound to protect server memory (files are
// buffered in RAM) — it's intentionally much larger than any platform's
// actual limit, since the background editor (mediaOptimizer.js) shrinks
// oversized files down to each platform's real limit before posting.
const RAW_UPLOAD_MAX_BYTES = 500_000_000; // 500 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: RAW_UPLOAD_MAX_BYTES,
    files: BLUESKY_LIMITS.maxImages,
  }
});

// ---- API routes ----
app.post('/api/post', upload.array('media', BLUESKY_LIMITS.maxImages), async (req, res) => {
  const text = (req.body?.text || '').trim();
  let targets = [];
  let altTexts = [];

  try {
    targets = JSON.parse(req.body?.targets || '[]');
    altTexts = JSON.parse(req.body?.altTexts || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'Malformed request.' });
  }

  if (!text) {
    return res.status(400).json({ error: 'Post text is required.' });
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'Select at least one platform.' });
  }

  let media;
  try {
    media = await validateMedia(req.files, targets);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const results = {};

  await Promise.all(targets.map(async (target) => {
    try {
      // Each platform gets its own edited copy of the media, built against
      // that platform's own (not the intersected/combined) limits.
      const targetLimits = await getLimitsForTargets([target]);
      const optimizedMedia = await optimizeMediaForTarget(media, targetLimits);

      if (target === 'bluesky') {
        results.bluesky = { ok: true, ...(await postToBluesky(text, optimizedMedia, altTexts)) };
      } else if (target === 'mastodon') {
        results.mastodon = { ok: true, ...(await postToMastodon(text, optimizedMedia, altTexts)) };
      }
    } catch (e) {
      results[target] = { ok: false, error: e.message };
    }
  }));

  res.json({ results });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
});

app.get('/api/config', async (req, res) => {
  // Lets the UI know which platforms are actually configured, plus each
  // platform's own media limits — the UI combines these based on whichever
  // checkboxes are currently checked, rather than always assuming both.
  const blueskyConfigured = Boolean(BLUESKY_HANDLE && BLUESKY_APP_PASSWORD);
  const mastodonConfigured = Boolean(MASTODON_ACCESS_TOKEN);
  const mastodonLimits = mastodonConfigured ? await getMastodonLimits() : MASTODON_DEFAULT_LIMITS;

  res.json({
    bluesky: blueskyConfigured,
    mastodon: mastodonConfigured,
    mastodonInstance: MASTODON_INSTANCE_URL,
    mediaLimits: {
      bluesky: BLUESKY_LIMITS,
      mastodon: mastodonLimits,
    },
  });
});

app.listen(PORT, () => {
  console.log(`Cross-post admin panel running at http://localhost:${PORT}`);
});
