const express = require('express');
const path = require('path');
const multer = require('multer');
const { imageSize } = require('image-size');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;

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
    const res = await fetch(`${MASTODON_INSTANCE_URL}/api/v2/instance`);
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

function humanBytes(n) {
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// Validate the uploaded files against the rules of whichever platforms are
// actually selected for this post. Returns { images: [file...], video: file|null }.
// Throws with a user-facing message on any violation.
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
    const video = videos[0];
    if (!limits.videoMimeTypes.includes(video.mimetype)) {
      throw new Error(`Video format ${video.mimetype} isn't supported by ${platformNote}. Use MP4.`);
    }
    if (video.size > limits.videoMaxBytes) {
      throw new Error(`Video is ${humanBytes(video.size)}, which exceeds the ${humanBytes(limits.videoMaxBytes)} limit for ${platformNote}.`);
    }
    return { images: [], video };
  }

  if (images.length > limits.maxImages) {
    throw new Error(`Up to ${limits.maxImages} images are allowed per post on ${platformNote}.`);
  }

  for (const img of images) {
    if (!limits.imageMimeTypes.includes(img.mimetype)) {
      throw new Error(`Image format ${img.mimetype} (${img.originalname}) isn't supported by ${platformNote}. Use JPEG, PNG, or WebP.`);
    }
    if (img.size > limits.imageMaxBytes) {
      throw new Error(`${img.originalname} is ${humanBytes(img.size)}, which exceeds the ${humanBytes(limits.imageMaxBytes)} limit for ${platformNote}.`);
    }
  }

  return { images, video: null };
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
  const sessionRes = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
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
  const res = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
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

  const postRes = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
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

  const res = await fetch(`${MASTODON_INSTANCE_URL}/api/v2/media`, {
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
    const pollRes = await fetch(`${MASTODON_INSTANCE_URL}/api/v1/media/${attachmentId}`, {
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

  const res = await fetch(`${MASTODON_INSTANCE_URL}/api/v1/statuses`, {
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: BLUESKY_LIMITS.videoMaxBytes, // largest single-file case (video); per-type checked in validateMedia
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
      if (target === 'bluesky') {
        results.bluesky = { ok: true, ...(await postToBluesky(text, media, altTexts)) };
      } else if (target === 'mastodon') {
        results.mastodon = { ok: true, ...(await postToMastodon(text, media, altTexts)) };
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
