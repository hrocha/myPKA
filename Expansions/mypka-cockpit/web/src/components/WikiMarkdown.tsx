// WikiMarkdown.tsx — renders a note body as markdown with [[wikilinks]] turned
// into clickable, navigable cockpit links. This is what makes graph browsing work:
// every wikilink inside a body opens the resolved note.
//
// Approach: react-markdown + remark-gfm render the markdown. Obsidian wikilinks
// are NOT standard markdown, so we PRE-TRANSFORM the body before handing it to
// react-markdown:
//   [[target|alias]]  -> [alias](cockpit:resolve/<slug>)
//   [[target]]        -> [target](cockpit:resolve/<slug>)
//   ![[Images/...]]   -> a media token rendered as a (graceful) <img> via the
//                        read-only media route; missing files degrade to a caption.
// Resolution itself happens server-side through the `links` table; here we just
// route the click to #/resolve/<slug>, and the universal viewer does the lookup.
//
// We never re-parse markdown to discover links for the graph (that's the server's
// `links` table). The transform here is purely for in-body click affordance.
import { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { navigate } from '../lib/router';
import { MediaImage } from './MediaImage';
import { workbenchAttachmentSrc } from '../lib/workbenchAttachments';

const COCKPIT_PREFIX = 'cockpit:resolve/';
const PKMIMG_PREFIX = 'pkmimg:';
const ATTACHMENT_PREFIX = '_attachments/';

// react-markdown@9 sanitizes every href/src through `defaultUrlTransform`, which
// allows ONLY http(s)/irc(s)/mailto/xmpp protocols and rewrites anything else to
// an EMPTY string. Our in-body wikilinks carry the custom `cockpit:resolve/<slug>`
// scheme and our images carry `pkmimg:<path>` — both got blanked to `href=""`,
// which then fell through to the external-anchor branch and opened a NEW TAB at
// `/` (the empty href resolves to the document root). This transform preserves
// our two internal schemes and defers to the default for everything else, so the
// `a`/`img` handlers below can route them in-app. This is the root-cause fix for
// "[[wikilinks]] in journal/note bodies open a new browser tab at root".
function cockpitUrlTransform(url: string): string {
  if (url.startsWith(COCKPIT_PREFIX) || url.startsWith(PKMIMG_PREFIX)) return url;
  return defaultUrlTransform(url);
}

// Slugify a wikilink target the same way the regen does: a path like
// "My Life/Topics/divertikulose" -> "divertikulose"; spaces/case normalised.
// The server resolver is the source of truth; this only has to produce the slug
// the user would click. We take the last path segment, lowercase, spaces->dashes.
function targetToSlug(target: string): string {
  const last = target.split(/[/\\]/).pop() ?? target;
  return last.trim().toLowerCase().replace(/\s+/g, '-');
}

// Escape the chars that are syntactically significant inside a markdown link
// LABEL, so a resolved title like "Weekly Review [2026]" or "A | B" can't break
// out of the `[label](url)` it's spliced into. Brackets + pipe are the only ones
// that matter for the inline-link grammar we emit here.
function escapeLinkLabel(s: string): string {
  return s.replace(/([[\]|\\])/g, '\\$1');
}

// Replace [[..]] and ![[..]] in raw markdown with link / image tokens.
//
// DATA-CONTRACT §12 display rules for the LABEL of a plain wikilink, in order:
//   1. an explicit `[[target|label]]` pipe alias  (author's intent wins)
//   2. the resolved target TITLE via resolveTitle(slug)  ("Weekly Review")
//   3. the raw slug  (honest orphan/unresolved fallback — never a crash)
// resolveTitle is the slug→title map NoteView builds from note.outbound; absent
// (e.g. a host that doesn't pass one) the renderer degrades to slug, exactly as
// before this change — fully backward-compatible.
function transformWikilinks(md: string, resolveTitle?: (slug: string) => string | null): string {
  if (!md) return '';
  let out = md;
  // Image / file embeds first: ![[path]]  (optionally ![[path|alt]])
  out = out.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, path: string, alt?: string) => {
    const p = path.trim();
    // Only treat Images/ embeds as renderable; other embeds become a quiet label.
    if (/^Images\//i.test(p) || /\.(png|jpe?g|gif|webp|svg)$/i.test(p)) {
      const altText = (alt || p.split('/').pop() || '').replace(/[\])]/g, '');
      return `![${altText}](pkmimg:${p})`;
    }
    return `*(embedded: ${p})*`;
  });
  // Plain wikilinks: [[target|alias]] or [[target]]
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const slug = targetToSlug(target);
    const explicit = alias?.trim();
    // Pipe alias wins; else resolved title; else the slug (§12 fallback chain).
    const resolved = explicit ? null : resolveTitle?.(slug)?.trim() || null;
    const label = explicit || resolved || target.trim();
    return `[${escapeLinkLabel(label)}](${COCKPIT_PREFIX}${slug})`;
  });
  return out;
}

// Components are built per (onWikilinkClick, isResolvable) so a host — e.g. the
// Workbench context panel — can intercept wikilink clicks (hop link-to-link in
// place) instead of the default full navigation to #/resolve/<slug>, and a host
// that knows which slugs have NO cockpit note (e.g. the team member-detail view,
// whose contract bodies link Team-Knowledge SOP/WS/GL files that the cockpit does
// not mirror as notes) can mark them unresolvable so they DEGRADE to a styled,
// non-clickable reference with a tooltip instead of routing to a 404 #/resolve.
const makeComponents = (
  onWikilinkClick?: (slug: string) => void,
  isResolvable?: (slug: string) => boolean,
): Components => ({
  a({ href, children, ...props }) {
    const h = href ?? '';
    if (h.startsWith(COCKPIT_PREFIX)) {
      const slug = h.slice(COCKPIT_PREFIX.length);
      // When a host supplies a resolvability oracle and says this target has no
      // cockpit view (a Team-Knowledge SOP/WS/GL slug, an `AGENTS`/`agent-index`
      // reference, etc.), render a non-interactive styled reference + tooltip —
      // the SAME honest degrade wave A uses for the connection pills and graph
      // nodes — rather than a button that navigates to a "No entry found" page.
      if (isResolvable && !isResolvable(slug)) {
        return (
          <span className="wikilink wikilink--unresolved" title={`${slug} — no in-cockpit view yet`}>
            {children}
          </span>
        );
      }
      return (
        <button
          type="button"
          className="wikilink"
          onClick={(e) => {
            e.preventDefault();
            if (onWikilinkClick) onWikilinkClick(slug);
            else navigate({ name: 'resolve', slug });
          }}
        >
          {children}
        </button>
      );
    }
    // Defense-in-depth: an empty/relative href must NEVER open a new tab at root.
    // (Belt to the urlTransform suspenders above — if any future custom scheme
    // slips through sanitization to "", we render plain text, not a stray anchor.)
    if (!h || h === '#' || h.startsWith('#')) {
      return <span className="ext-link">{children}</span>;
    }
    // External / normal links open in a new tab (rare inside PKM notes).
    return (
      <a href={h} target="_blank" rel="noreferrer noopener" className="ext-link" {...props}>
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const s = typeof src === 'string' ? src : '';
    if (s.startsWith(PKMIMG_PREFIX)) {
      return <MediaImage path={s.slice(PKMIMG_PREFIX.length)} caption={alt || null} />;
    }
    // Workbench attachment: a RELATIVE `_attachments/<uuid>.<ext>` path. Rewrite to
    // the jailed, inert media API URL at render time (display-src resolution); the
    // markdown keeps the relative path. A hand-typed `![](_attachments/x.png)`
    // renders through this branch too.
    if (s.startsWith(ATTACHMENT_PREFIX)) {
      return (
        <img
          className="wb-img-el wb-img-el--readonly"
          src={workbenchAttachmentSrc(s)}
          alt={alt || ''}
          loading="lazy"
          decoding="async"
        />
      );
    }
    // Non-PKM images are not expected in note bodies; render defensively.
    return <MediaImage path={s} caption={alt || null} />;
  },
});

// =============================================================================
// Raw-HTML neutralisation (defense-in-depth, render side).
// =============================================================================
// react-markdown@9 parses raw HTML in the body into `raw` nodes and — by default —
// turns them into TEXT (inert, but ugly), while `skipHtml` (set on <ReactMarkdown>
// below) DROPS them entirely. Either way react-markdown does not execute them.
// BUT note bodies can carry pasted embeds (e.g. an X/Twitter `<blockquote
// class="twitter-tweet">…<script src="platform.twitter.com/widgets.js">`). Under
// the cockpit CSP (`script-src 'self'`) such inline/3rd-party scripts are correctly
// blocked, but executable content should never reach the render pipeline at all.
//
// This pre-pass strips the dangerous constructs from the raw markdown string BEFORE
// react-markdown sees it, so nothing relies on a single library default:
//   * <script>…</script>            → removed (tag + contents)
//   * <iframe|object|embed|…>        → removed (tag + contents)
//   * inline event handlers (on*=)   → stripped from any surviving tag
//   * javascript: in href/src        → neutralised
// Legitimate markdown (headings, lists, code fences, links, images, tables) is
// untouched — we only target raw embedded HTML elements that have no place in a
// PKM/outer-world note body.
const DANGEROUS_BLOCK_TAGS = 'script|iframe|object|embed|noscript|template|style|link|meta|base|form';

function neutralizeRawHtml(md: string): string {
  if (!md || md.indexOf('<') === -1) return md || '';
  let out = md;
  // Drop dangerous elements WITH their contents (covers <script>…</script>,
  // <iframe>…</iframe>, etc.) — non-greedy, case-insensitive, dot-matches-newline.
  const blockRe = new RegExp(`<(${DANGEROUS_BLOCK_TAGS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
  out = out.replace(blockRe, '');
  // Drop any self-closing / unclosed dangerous opening tags left behind.
  const openRe = new RegExp(`<(${DANGEROUS_BLOCK_TAGS})\\b[^>]*>`, 'gi');
  out = out.replace(openRe, '');
  // Strip inline event-handler attributes (on*=) from any surviving raw tag.
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Neutralise javascript:/vbscript: in any raw href/src that slipped through.
  out = out.replace(/((?:href|src)\s*=\s*)(["']?)\s*(?:javascript|vbscript):[^"'\s>]*/gi, '$1$2#');
  return out;
}

// PKM note bodies usually open with a `# Title` H1 that repeats the note name —
// the viewer already shows the title in its header, so we drop a single leading
// H1 to avoid the doubled heading. Only the FIRST line, only if it's an H1.
function dropLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n+/, '');
}

function WikiMarkdownImpl({
  body,
  onWikilinkClick,
  resolveTitle,
  isResolvable,
}: {
  body: string;
  /** Intercept in-body wikilink clicks (default: navigate to #/resolve/<slug>).
   *  Pass a STABLE callback — this component is memoized on its props. */
  onWikilinkClick?: (slug: string) => void;
  /** DATA-CONTRACT §12 — resolve a wikilink target slug to its display title.
   *  When provided, a `[[slug]]` with no explicit `|label` renders the resolved
   *  title instead of the raw slug. Pass a STABLE callback (the body transform is
   *  memoized on it). */
  resolveTitle?: (slug: string) => string | null;
  /** Returns false for a wikilink target that has NO cockpit view (e.g. a
   *  Team-Knowledge SOP/WS/GL file the mirror doesn't carry as a note). Such a
   *  target degrades to a non-clickable styled reference + tooltip instead of
   *  navigating to a "No entry found" #/resolve page. Omit it to keep every
   *  wikilink clickable (the universal-note-viewer default). STABLE callback. */
  isResolvable?: (slug: string) => boolean;
}) {
  const transformed = useMemo(
    // neutralizeRawHtml FIRST (strip <script>/<iframe>/on*= from raw embeds), then
    // drop the leading H1, then expand wikilinks. Order matters: sanitise before we
    // hand anything downstream.
    () => transformWikilinks(dropLeadingH1(neutralizeRawHtml(body)), resolveTitle),
    [body, resolveTitle],
  );
  const components = useMemo(
    () => makeComponents(onWikilinkClick, isResolvable),
    [onWikilinkClick, isResolvable],
  );
  return (
    <div className="note-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={cockpitUrlTransform}
        components={components}
        skipHtml
      >
        {transformed}
      </ReactMarkdown>
    </div>
  );
}

export const WikiMarkdown = memo(WikiMarkdownImpl);
