#!/usr/bin/env node
// fetch-embed.mjs — Outer World capture-time embed fetcher (Item 10).
//
// WHAT THIS IS
//   A CAPTURE-TIME helper. When Tom saves external content into his myPKA, the
//   LLM (Larry, who has network access at save time) runs this once against the
//   URL. It classifies the link, fetches OG/oEmbed metadata, optionally localizes
//   the preview image into PKM/Images/, and prints a FLAT `embed_*` frontmatter
//   block. The cockpit then renders a STATIC rich card OFFLINE from that block —
//   it never hits the network at view time. This script is NOT a cockpit-runtime
//   dependency: nothing in server/ or web/ imports it.
//
// USAGE
//   node scripts/fetch-embed.mjs "<url>" [--no-localize] [--json] [--note <slug>]
//
//   --no-localize   Skip downloading the preview image; keep the remote https URL
//                   in embed_image (still validated https-only).
//   --json          Emit a JSON object instead of a YAML frontmatter block (for
//                   programmatic callers that splice fields themselves).
//   --note <slug>   Slug used in the localized image filename
//                   (YYYY-MM-DD-<slug>-embed.<ext>). Defaults to the domain.
//
// FIELD CONTRACT (matches Silas's flat schema)
//   embed_kind         article | post | video | image | link
//   embed_title        TEXT, <= 200 chars
//   embed_description  TEXT, <= 500 chars
//   embed_image        PKM/-relative local path (e.g. Images/2026/06/x.png) when
//                      localized, else a remote https URL, else null
//   embed_site_name    TEXT
//   embed_domain       canonical host, www-stripped
//   embed_favicon      https URL or null
//   embed_author       TEXT (handle / author_name) or null
//   embed_captured_at  ISO-8601 UTC timestamp of this fetch
//   source_url         the original URL the user saved
//   source_type        always "outer_world"
//
// SECURITY POSTURE (Axon)
//   - All fetched strings are sanitized to TEXT: HTML tags stripped, control
//     chars removed, whitespace collapsed, length-capped. No HTML reaches the
//     frontmatter, so the cockpit's offline card renders inert text only.
//   - Image URLs MUST be https before download; non-https → not localized.
//   - 10s timeout per request; bot-blocked / 404 / parse-fail degrades to a
//     minimal card (domain + source_url + kind). The script NEVER throws on a
//     dead URL — graceful degradation is the contract.
//   - No third-party scripts / npm deps. Node stdlib + built-in fetch + a tiny
//     hand-rolled meta-tag extractor (no DOM library, no eval).
//   - X/Twitter: use the official publish.x.com (publish.twitter.com) oEmbed
//     endpoint — NO authentication, NO browser. A plain fetch of the tweet page
//     itself is auth-walled (402) and must never be attempted. oEmbed returns a
//     blockquote HTML string; we extract ONLY the tweet <p> text, strip ALL tags,
//     and keep author_name from the JSON. The blockquote HTML never reaches the
//     frontmatter (verified 2026-06-18 against x.com/goando/status/...).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Scaffold root (reuse the cockpit's ONE resolver, read-only import) ──────
// We import REPO_ROOT rather than recomputing it so localized images land in the
// exact PKM/ the cockpit serves from. If the import fails (e.g. run standalone
// outside the cockpit tree), we fall back to a relative walk so the classifier
// + metadata fetch still work; localization just degrades to remote URL.
let REPO_ROOT = null;
try {
  ({ REPO_ROOT } = await import('../server/repoRoot.js'));
} catch {
  // Standalone fallback: walk up from this file for the AGENTS.md + PKM/ pair.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = path.resolve(here, '..');
  for (let i = 0; i < 8; i++) {
    try {
      if (
        fs.existsSync(path.join(dir, 'AGENTS.md')) &&
        fs.statSync(path.join(dir, 'PKM')).isDirectory()
      ) {
        REPO_ROOT = dir;
        break;
      }
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 10_000;
const TITLE_CAP = 200;
const DESC_CAP = 500;
const TEXT_CAP = 500; // generic cap for any other sanitized string
const SOURCE_TYPE = 'outer_world';

// Multiple UAs (ported from fetch-link-preview/index.ts) — try in order on 403/429.
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
];

// ─── Classifier regexes (ported from markdownRender.ts) ──────────────────────
// We port the *logic* and ordering, but map the rich myICOR EmbedKind taxonomy
// (tweet/video/internal/link/image/tiktok/linkedin/instagram) onto the cockpit's
// Outer World taxonomy: article | post | video | image | link.
//   - YouTube/Vimeo/Loom video providers → 'video'
//   - X/Twitter, TikTok, LinkedIn, Instagram social posts → 'post'
//   - direct image URLs → 'image'
//   - everything else → 'article' if it scrapes article-shaped OG, else 'link'
const X_STATUS_RE = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/;
const TIKTOK_VIDEO_RE = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/;
const LINKEDIN_ACTIVITY_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/posts\/[^/?#]*?-activity-(\d{19})/;
const LINKEDIN_URN_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/feed\/update\/urn:li:(activity|share):(\d{1,25})/;
const INSTAGRAM_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(p|reel)\/([A-Za-z0-9_-]{1,40})(?:[/?#]|$)/;

// Video providers (ported from matchVideoUrl).
const YT_WATCH_RE = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:[^#\s]*&)?v=([\w-]{11})/;
const YT_SHORT_RE = /^https?:\/\/youtu\.be\/([\w-]{11})/;
const YT_PATH_RE = /^https?:\/\/(?:www\.)?youtube\.com\/(?:shorts|embed|v|live)\/([\w-]{11})/;
const VIMEO_RE = /^https?:\/\/(?:www\.)?vimeo\.com\/(?:channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?(\d+)/i;
const VIMEO_PLAYER_RE = /^https?:\/\/player\.vimeo\.com\/video\/(\d+)/i;
const LOOM_RE = /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-z0-9]+)/i;

// Direct-image URL test (ported from DIRECT_IMAGE_RE).
const DIRECT_IMAGE_RE = /(\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$))/i;

// Tracking-pixel / icon filter (ported from isValidImageUrl).
const IMAGE_SKIP_PATTERNS = [
  'tracking', 'pixel', '1x1', 'spacer', 'blank',
  'facebook.com/tr', 'google-analytics', 'doubleclick',
  '.gif', 'favicon', 'icon',
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function resolveUrl(base, relative) {
  if (!relative) return null;
  try {
    return new URL(relative, base).href;
  } catch {
    return relative.startsWith('http') ? relative : null;
  }
}

function isValidImageUrl(imageUrl) {
  if (!imageUrl) return false;
  const lower = imageUrl.toLowerCase();
  return !IMAGE_SKIP_PATTERNS.some((p) => lower.includes(p));
}

// Sanitize any fetched string to inert TEXT. Strips tags, decodes a small set of
// HTML entities, removes control chars, collapses whitespace, caps length. This
// is the security boundary — nothing that reaches frontmatter is markup.
function sanitizeText(raw, cap = TEXT_CAP) {
  if (raw == null) return null;
  let s = String(raw);
  s = s.replace(/<[^>]*>/g, ' ');             // strip tags
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#0?39;|&apos;/gi, "'")
       .replace(/&#x27;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_, n) => {       // numeric entities (safe range only)
    const code = Number(n);
    return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  });
  s = s.replace(/[ -]/g, ' '); // control chars
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > cap ? s.slice(0, cap).trim() : s;
}

// Extract the TWEET TEXT from an oEmbed `html` blockquote string. The oEmbed
// payload looks like:
//   <blockquote ...><p ...>TWEET TEXT<br><br>more text <a href="t.co/…">pic…</a></p>
//   &mdash; Author Name (@handle) <a href="…/status/…">June 18, 2026</a></blockquote>
// We want ONLY the inner <p> text (the tweet itself) — NOT the trailing
// "&mdash; Author (@handle) <date>" attribution line, which would duplicate the
// author field. We pull the first <p>…</p>, convert <br> to spaces so line
// breaks don't glue words, then hand the result to sanitizeText to strip every
// remaining tag (incl. any residual <script>), decode entities, and length-cap.
// If no <p> is found we degrade to sanitizing the whole blockquote (still inert).
function extractTweetText(oembedHtml, cap = DESC_CAP) {
  if (!oembedHtml) return null;
  const pMatch = String(oembedHtml).match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  const inner = pMatch ? pMatch[1] : String(oembedHtml);
  // <br> / <br/> → space BEFORE sanitizeText collapses tags, so consecutive
  // <br><br> don't fuse adjacent words together.
  const withBreaks = inner.replace(/<br\s*\/?>/gi, ' ');
  return sanitizeText(withBreaks, cap);
}

// match video provider → { provider, id } | null  (ported from matchVideoUrl)
function matchVideoUrl(url) {
  let m;
  if ((m = url.match(YT_WATCH_RE)) || (m = url.match(YT_SHORT_RE)) || (m = url.match(YT_PATH_RE))) {
    return { provider: 'youtube', id: m[1] };
  }
  if ((m = url.match(VIMEO_PLAYER_RE)) || (m = url.match(VIMEO_RE))) {
    return { provider: 'vimeo', id: m[1] };
  }
  if ((m = url.match(LOOM_RE))) {
    return { provider: 'loom', id: m[1] };
  }
  return null;
}

// Classify a URL into { kind, provider?, videoId?, handle? }.
// kind ∈ video | post | image | article | link  (article vs link decided later
// once we know whether the page yielded article-shaped OG metadata).
function classifyEmbedUrl(url) {
  const trimmed = url.trim();

  const video = matchVideoUrl(trimmed);
  if (video) return { kind: 'video', provider: video.provider, videoId: video.id };

  const x = trimmed.match(X_STATUS_RE);
  if (x) {
    // Handle is the path segment before /status/.
    let handle = null;
    const h = trimmed.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\//);
    if (h) handle = '@' + h[1];
    return { kind: 'post', provider: 'x', tweetId: x[1], handle };
  }
  if (TIKTOK_VIDEO_RE.test(trimmed)) return { kind: 'post', provider: 'tiktok' };
  if (LINKEDIN_ACTIVITY_RE.test(trimmed) || LINKEDIN_URN_RE.test(trimmed)) {
    return { kind: 'post', provider: 'linkedin' };
  }
  if (INSTAGRAM_RE.test(trimmed)) return { kind: 'post', provider: 'instagram' };

  if (DIRECT_IMAGE_RE.test(trimmed)) return { kind: 'image', provider: 'image' };

  return { kind: 'link', provider: 'generic' }; // upgraded to 'article' if OG says so
}

// ─── Network ──────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, extraHeaders = {}) {
  for (const ua of USER_AGENTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
      });
      clearTimeout(t);
      if (res.ok) return res;
      if (res.status === 403 || res.status === 429) continue; // try next UA
      return res; // other status: return as-is (caller checks .ok)
    } catch {
      continue; // timeout / network error → next UA
    }
  }
  return null;
}

// Pull a meta-tag content by trying property/name variants, in OG precedence.
// Hand-rolled (no DOM lib): scan all <meta ...> tags once into a small map.
function buildMetaMap(html) {
  const map = new Map();
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const key =
      (tag.match(/\bproperty\s*=\s*["']([^"']+)["']/i) ||
        tag.match(/\bname\s*=\s*["']([^"']+)["']/i) ||
        tag.match(/\bitemprop\s*=\s*["']([^"']+)["']/i));
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (key && content) {
      const k = key[1].toLowerCase();
      if (!map.has(k)) map.set(k, content[1]); // first wins (OG precedence)
    }
  }
  return map;
}

// getMeta precedence (ported): og:<p> → name=<p> → twitter:<p> → name=twitter:<p>
function getMeta(map, prop) {
  return (
    map.get(`og:${prop}`) ??
    map.get(prop) ??
    map.get(`twitter:${prop}`) ??
    null
  );
}

// extractBestImage ladder (ported from extractBestImage, meta-only strategies —
// the DOM content-image strategies 6/7 are dropped because we don't parse a DOM;
// OG/twitter/schema/article/link-rel cover the overwhelming majority of cards).
function extractBestImage(map, html, baseUrl) {
  const candidates = [
    map.get('og:image'),
    map.get('og:image:url'),
    map.get('twitter:image'),
    map.get('twitter:image:src'),
    map.get('image'),            // itemprop / schema.org
    map.get('article:image'),
  ];
  for (const c of candidates) {
    if (c && isValidImageUrl(c)) return resolveUrl(baseUrl, c);
  }
  // link rel="image_src" (older standard) — quick scan.
  const linkImg = html.match(/<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*>/i);
  if (linkImg) {
    const href = linkImg[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href && isValidImageUrl(href[1])) return resolveUrl(baseUrl, href[1]);
  }
  return null;
}

function extractFavicon(html, baseUrl) {
  const re = /<link\b[^>]*rel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    const resolved = resolveUrl(baseUrl, href[1]);
    // http(s) only — never carry a data: / blob: / inline favicon into the card
    // (keeps the cockpit's offline card CSP clean; data URIs are usually 1x1 junk).
    if (resolved && /^https?:\/\//i.test(resolved)) return resolved;
  }
  return null;
}

function extractTitleTag(html) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1] : null;
}

// ─── Per-kind metadata fetchers ───────────────────────────────────────────────

// Generic / article: OG/Twitter-card scrape (algorithm ported from
// fetch-link-preview/index.ts → fetchOgData/getMeta/extractBestImage).
async function fetchGeneric(url) {
  const domain = extractDomain(url);
  const base = {
    title: null, description: null, image: null,
    site_name: null, favicon: null, author: null,
    article_shaped: false,
  };
  const res = await fetchWithRetry(url);
  if (!res || !res.ok) return base; // graceful degradation → minimal card
  let html;
  try {
    html = await res.text();
  } catch {
    return base;
  }
  const map = buildMetaMap(html);
  const ogType = (map.get('og:type') || '').toLowerCase();

  return {
    title: sanitizeText(getMeta(map, 'title') ?? extractTitleTag(html), TITLE_CAP),
    description: sanitizeText(getMeta(map, 'description'), DESC_CAP),
    image: extractBestImage(map, html, url),
    site_name: sanitizeText(getMeta(map, 'site_name')),
    favicon: extractFavicon(html, url),
    author: sanitizeText(
      map.get('article:author') ?? map.get('author') ?? map.get('twitter:creator'),
    ),
    // An og:type of article (or news/blog) means render the article card.
    article_shaped: ogType.includes('article') || ogType.includes('news') || ogType.includes('blog'),
  };
}

// YouTube: public oEmbed (no key).
async function fetchYouTube(url, videoId) {
  const out = {
    title: null, description: null,
    image: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null,
    site_name: 'YouTube',
    favicon: 'https://www.youtube.com/s/desktop/favicon.ico',
    author: null,
  };
  try {
    const o = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetchWithRetry(o, { Accept: 'application/json' });
    if (res && res.ok) {
      const d = await res.json();
      out.title = sanitizeText(d.title, TITLE_CAP);
      out.author = sanitizeText(d.author_name);
      if (d.thumbnail_url && isValidImageUrl(d.thumbnail_url)) out.image = d.thumbnail_url;
    }
  } catch { /* keep constructed thumbnail */ }
  return out;
}

// Vimeo / Loom: their public oEmbed endpoints (no key).
async function fetchOEmbed(provider, url) {
  const endpoint =
    provider === 'vimeo'
      ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
      : `https://www.loom.com/v1/oembed?url=${encodeURIComponent(url)}`;
  const out = {
    title: null, description: null, image: null,
    site_name: provider === 'vimeo' ? 'Vimeo' : 'Loom',
    favicon: provider === 'vimeo' ? 'https://vimeo.com/favicon.ico' : 'https://www.loom.com/favicon.ico',
    author: null,
  };
  try {
    const res = await fetchWithRetry(endpoint, { Accept: 'application/json' });
    if (res && res.ok) {
      const d = await res.json();
      out.title = sanitizeText(d.title, TITLE_CAP);
      out.description = sanitizeText(d.description, DESC_CAP);
      out.author = sanitizeText(d.author_name);
      const img = d.thumbnail_url || d.cover_image_url;
      if (img && isValidImageUrl(img)) out.image = img;
    }
  } catch { /* minimal card */ }
  return out;
}

// X / Twitter: official oEmbed endpoint — NO auth, NO browser.
//   https://publish.twitter.com/oembed?url=<tweet>&omit_script=1&dnt=true&hide_thread=true
// (publish.twitter.com 301-redirects to publish.x.com; built-in fetch follows it.)
// Returns JSON { html (blockquote), author_name, author_url, provider_name, … }.
// We extract ONLY the tweet <p> text from `html` (tags stripped), use author_name
// + the @handle from the URL, and set site_name to the oEmbed provider_name ("X").
// A plain fetch of the tweet page is auth-walled (HTTP 402) — we MUST NOT do that.
// omit_script=1 already drops the widget <script>; extractTweetText strips any
// residual markup so the stored card can never contain executable HTML.
async function fetchTwitter(url, handle) {
  const out = {
    title: null,
    description: null,
    image: null, // oEmbed exposes no card image without the widget; intentionally none
    site_name: 'X',
    favicon: 'https://abs.twimg.com/favicons/twitter.ico',
    author: handle || null,
  };
  try {
    const endpoint =
      'https://publish.twitter.com/oembed?url=' +
      encodeURIComponent(url) +
      '&omit_script=1&dnt=true&hide_thread=true';
    const res = await fetchWithRetry(endpoint, { Accept: 'application/json' });
    if (res && res.ok) {
      const d = await res.json();
      const text = extractTweetText(d.html, DESC_CAP);
      // Title = first line / leading snippet of the tweet (≤ TITLE_CAP); the full
      // tweet text goes in description. Both are already tag-stripped TEXT.
      out.title = text ? sanitizeText(text, TITLE_CAP) : null;
      out.description = text;
      out.author = sanitizeText(d.author_name) || handle || null;
      if (d.provider_name) out.site_name = sanitizeText(d.provider_name) || 'X';
    }
  } catch {
    /* oEmbed unreachable → minimal X card (handle + site_name only); never
       fall back to a plain page fetch (402) or a browser. */
  }
  return out;
}

// TikTok / LinkedIn / Instagram. Per-platform no-auth reality (verified 2026-06-18):
//   - TikTok: public oEmbed (https://www.tiktok.com/oembed?url=…) works WITHOUT a
//     token → title + author + thumbnail. Preferred.
//   - LinkedIn: oEmbed requires an authenticated app; OG scrape of the public post
//     is often bot-walled. Fall back to OG, then to a minimal honest card.
//   - Instagram: oEmbed now requires a Facebook app access token (graph.facebook.com
//     /instagram_oembed → OAuthException without one). OG scrape is login-walled.
//     Fall back to a minimal honest card.
// In every case the output is tag-stripped TEXT only; no raw embed HTML is stored.
async function fetchSocial(url, providerLabel) {
  // TikTok has a real no-auth oEmbed — use it first.
  if (providerLabel === 'tiktok') {
    try {
      const endpoint = 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(url);
      const res = await fetchWithRetry(endpoint, { Accept: 'application/json' });
      if (res && res.ok) {
        const d = await res.json();
        return {
          title: sanitizeText(d.title, TITLE_CAP),
          description: sanitizeText(d.title, DESC_CAP),
          image: d.thumbnail_url && isValidImageUrl(d.thumbnail_url) ? d.thumbnail_url : null,
          site_name: sanitizeText(d.provider_name) || 'TikTok',
          favicon: 'https://www.tiktok.com/favicon.ico',
          author: sanitizeText(d.author_name) || null,
        };
      }
    } catch { /* fall through to OG scrape */ }
  }

  // LinkedIn / Instagram (and TikTok if oEmbed failed): try OG scrape of the public
  // page; if blocked, emit a minimal honest card (label below + URL author).
  const generic = await fetchGeneric(url);
  return {
    title: generic.title,
    description: generic.description,
    image: generic.image,
    site_name: generic.site_name || providerLabelDisplay(providerLabel),
    favicon: generic.favicon,
    author: generic.author || authorFromUrl(url, providerLabel),
  };
}

// Human-readable site name for a provider slug (for the minimal honest card).
function providerLabelDisplay(provider) {
  return (
    { tiktok: 'TikTok', linkedin: 'LinkedIn', instagram: 'Instagram' }[provider] ||
    (provider ? provider[0].toUpperCase() + provider.slice(1) : null)
  );
}

// Best-effort author from the URL path when no metadata is available — e.g.
// instagram.com/<user>/p/<id> → "@<user>", linkedin.com/posts/<slug> → "<slug>".
// Honest, minimal, never fabricated beyond what the URL literally contains.
function authorFromUrl(url, provider) {
  try {
    const u = new URL(url);
    if (provider === 'instagram') {
      const seg = u.pathname.split('/').filter(Boolean);
      // /<user>/p/<id> or /<user>/reel/<id> — user is the first segment unless it's p/reel.
      if (seg[0] && seg[0] !== 'p' && seg[0] !== 'reel') return '@' + sanitizeText(seg[0]);
    }
    if (provider === 'linkedin') {
      const m = u.pathname.match(/\/posts\/([^/?#]+?)-activity-/);
      if (m) return sanitizeText(m[1].replace(/-/g, ' '));
    }
  } catch { /* ignore */ }
  return null;
}

// Direct image URL: the URL itself IS the image.
function fetchDirectImage(url) {
  return {
    title: null,
    description: null,
    image: isValidImageUrl(url) ? url : url, // direct image: keep as-is for localize
    site_name: extractDomain(url),
    favicon: null,
    author: null,
  };
}

// ─── Image localization (option A) ─────────────────────────────────────────────
// Download the chosen preview image into PKM/Images/YYYY/MM/ and return the
// PKM/-relative path the cockpit serves via /api/cockpit/media. Falls back to the
// remote https URL on any failure. https-only is enforced before download.

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function extFromUrl(u) {
  const m = u.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
  const e = m ? m[1].toLowerCase() : null;
  return ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg'].includes(e) ? (e === 'jpeg' ? 'jpg' : e) : null;
}

async function localizeImage(imageUrl, slug) {
  if (!imageUrl) return { local: null, remote: null };
  // https-only gate.
  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return { local: null, remote: null };
  }
  if (parsed.protocol !== 'https:') {
    // Not https → never download; do not even keep it as a card image.
    return { local: null, remote: null };
  }
  // If we can't resolve PKM/, degrade to remote URL.
  if (!REPO_ROOT) return { local: null, remote: imageUrl };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(imageUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENTS[0], Accept: 'image/*' },
    });
    clearTimeout(t);
    if (!res || !res.ok) return { local: null, remote: imageUrl };

    const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ctype && !ctype.startsWith('image/')) return { local: null, remote: imageUrl };

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { local: null, remote: imageUrl };

    const ext = EXT_BY_MIME[ctype] || extFromUrl(imageUrl) || 'jpg';
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');

    const safeSlug = (slug || 'embed')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'embed';

    const relDir = path.join('Images', yyyy, mm);
    const absDir = path.join(REPO_ROOT, 'PKM', relDir);
    fs.mkdirSync(absDir, { recursive: true });

    let fileName = `${yyyy}-${mm}-${dd}-${safeSlug}-embed.${ext}`;
    let absFile = path.join(absDir, fileName);
    let n = 1;
    while (fs.existsSync(absFile)) {
      fileName = `${yyyy}-${mm}-${dd}-${safeSlug}-embed-${n}.${ext}`;
      absFile = path.join(absDir, fileName);
      n += 1;
    }
    fs.writeFileSync(absFile, buf);

    // PKM/-relative path, forward slashes (the cockpit's media route convention).
    const relPath = path.join(relDir, fileName).replace(/\\/g, '/');
    return { local: relPath, remote: imageUrl };
  } catch {
    return { local: null, remote: imageUrl };
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

async function buildEmbed(url, { localize, noteSlug }) {
  const sourceUrl = url.trim();
  const domain = extractDomain(sourceUrl);
  const captured_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const cls = classifyEmbedUrl(sourceUrl);
  let meta;
  let kind = cls.kind;

  if (cls.kind === 'video' && cls.provider === 'youtube') {
    meta = await fetchYouTube(sourceUrl, cls.videoId);
  } else if (cls.kind === 'video') {
    meta = await fetchOEmbed(cls.provider, sourceUrl);
  } else if (cls.kind === 'post' && cls.provider === 'x') {
    meta = await fetchTwitter(sourceUrl, cls.handle);
  } else if (cls.kind === 'post') {
    meta = await fetchSocial(sourceUrl, cls.provider);
  } else if (cls.kind === 'image') {
    meta = fetchDirectImage(sourceUrl);
  } else {
    // link → maybe article. Decide kind from og:type.
    meta = await fetchGeneric(sourceUrl);
    kind = meta.article_shaped ? 'article' : 'link';
  }

  // Resolve the preview image: localize (default) or keep remote https.
  let embed_image = null;
  if (meta.image) {
    if (localize) {
      const slug = noteSlug || domain.replace(/\./g, '-') || 'embed';
      const { local, remote } = await localizeImage(meta.image, slug);
      embed_image = local || remote || null; // local first, then validated remote, else null
    } else {
      // --no-localize: keep remote, but still https-only.
      try {
        embed_image = new URL(meta.image).protocol === 'https:' ? meta.image : null;
      } catch {
        embed_image = null;
      }
    }
  }

  return {
    embed_kind: kind,
    embed_title: meta.title || null,
    embed_description: meta.description || null,
    embed_image,
    embed_site_name: meta.site_name || null,
    embed_domain: domain || null,
    embed_favicon: meta.favicon || null,
    embed_author: meta.author || null,
    embed_captured_at: captured_at,
    source_url: sourceUrl,
    source_type: SOURCE_TYPE,
  };
}

// ─── YAML emit ──────────────────────────────────────────────────────────────────
// Minimal, safe scalar serializer: every string value is double-quoted with
// embedded quotes/backslashes escaped, so a sanitized title with a colon or '#'
// never breaks YAML. nulls emit bare `null`.
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  const s = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${s}"`;
}

function toFrontmatter(obj) {
  const order = [
    'embed_kind', 'embed_title', 'embed_description', 'embed_image',
    'embed_site_name', 'embed_domain', 'embed_favicon', 'embed_author',
    'embed_captured_at', 'source_url', 'source_type',
  ];
  const lines = order.map((k) => `${k}: ${yamlScalar(obj[k])}`);
  return lines.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { url: null, localize: true, json: false, noteSlug: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-localize') args.localize = false;
    else if (a === '--json') args.json = true;
    else if (a === '--note') { args.noteSlug = argv[++i] || null; }
    else if (!a.startsWith('--') && !args.url) args.url = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    process.stderr.write(
      'Usage: node scripts/fetch-embed.mjs "<url>" [--no-localize] [--json] [--note <slug>]\n',
    );
    process.exit(2);
  }
  // Validate the URL up front. An invalid URL still yields a minimal card rather
  // than an error, per the graceful-degradation contract.
  try {
    // eslint-disable-next-line no-new
    new URL(args.url);
  } catch {
    const fallback = {
      embed_kind: 'link', embed_title: null, embed_description: null,
      embed_image: null, embed_site_name: null, embed_domain: null,
      embed_favicon: null, embed_author: null,
      embed_captured_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      source_url: String(args.url), source_type: SOURCE_TYPE,
    };
    process.stdout.write(args.json ? JSON.stringify(fallback, null, 2) + '\n' : toFrontmatter(fallback) + '\n');
    return;
  }

  let embed;
  try {
    embed = await buildEmbed(args.url, { localize: args.localize, noteSlug: args.noteSlug });
  } catch {
    // Last-resort degradation — never throw to the caller.
    embed = {
      embed_kind: 'link', embed_title: null, embed_description: null,
      embed_image: null, embed_site_name: null,
      embed_domain: extractDomain(args.url) || null,
      embed_favicon: null, embed_author: null,
      embed_captured_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      source_url: args.url, source_type: SOURCE_TYPE,
    };
  }
  process.stdout.write(args.json ? JSON.stringify(embed, null, 2) + '\n' : toFrontmatter(embed) + '\n');
}

// Run the CLI only when invoked directly (`node scripts/fetch-embed.mjs ...`),
// not when imported for testing/reuse — so `import { classifyEmbedUrl }` has no
// side effects.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

// Exported for unit testing / programmatic reuse (no side effects on import).
export { classifyEmbedUrl, sanitizeText, isValidImageUrl, extractDomain, buildEmbed, toFrontmatter };
