// workbenchAttachments.ts — upload an attachment blob (raster image or PDF) to
// the Workbench attachments store and resolve a stored relative path to a
// display URL.
//
// SSOT for the relative↔display mapping (plan §B3/§B4): markdown stores the
// RELATIVE path (`_attachments/<uuid>.<ext>`); the DISPLAY url is derived here,
// at render time only, through the read-only, jailed, inert media route:
//   _attachments/<uuid>.<ext>  →  /api/cockpit/file?path=Fleeting%20Notes/<relative>
//
// Upload contract (Mack's backend, dormant behind WORKBENCH_WRITE_ENABLED):
//   POST /api/cockpit/notes/attachments
//   headers: X-Cockpit: 1  (CSRF belt) + same-origin session cookie
//   body: { dataBase64 }   (a `data:...;base64,` prefix is tolerated)
//   201 { ok, path:"_attachments/<uuid>.<ext>", filename, bytes, sha256 }
//   400 invalid · 413 over the cap (10 MB images / 20 MB PDFs)
//   415 not PNG/JPEG/GIF/WebP/PDF (SVG rejected) · 409 collision · 503 disabled
// The server sniffs magic bytes and derives the written extension itself —
// images insert as image nodes, PDFs insert as plain markdown links
// (OutlinerEditor decides by the local file's type, the server by the bytes).

const ATTACHMENT_PREFIX = '_attachments/';

// Resolve a stored RELATIVE attachment path to its display URL. A `_attachments/`
// path is served via the jailed media route under the Workbench root. Anything
// that doesn't look like our relative attachment path is passed through untouched
// (defensive — a hand-typed absolute/external src renders as-is, never rewritten).
export function workbenchAttachmentSrc(relativePath: string): string {
  const p = (relativePath ?? '').trim();
  if (!p) return '';
  if (p.startsWith(ATTACHMENT_PREFIX)) {
    return `/api/cockpit/file?path=${encodeURIComponent(`Fleeting Notes/${p}`)}`;
  }
  return p;
}

// Discriminated upload result so callers branch without parsing HTTP codes.
export type UploadResult =
  | { kind: 'ok'; path: string; filename: string; bytes: number; sha256: string }
  | { kind: 'invalid' } //     400 — malformed payload
  | { kind: 'too-large' } //   413 — over the cap (10 MB images / 20 MB PDFs)
  | { kind: 'unsupported' } // 415 — not PNG/JPEG/GIF/WebP/PDF (SVG rejected)
  | { kind: 'conflict' } //    409 — uuid collision (server retries; surfaced calmly)
  | { kind: 'disabled' } //    503 — WORKBENCH_WRITE_ENABLED off (Vex gate)
  | { kind: 'auth' } //        401 — session gone
  | { kind: 'error'; status: number; message: string };

interface UploadOkBody {
  ok?: boolean;
  path?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  error?: string;
  message?: string;
}

// Read a Blob/File as a base64 data URL (`data:<mime>;base64,<...>`). The server
// tolerates the prefix, so we send the whole data URL unchanged.
export function blobToDataBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// POST an image blob to the attachments endpoint. Returns the RELATIVE path on
// success; the caller stores that in the node (and thus in markdown).
export async function uploadWorkbenchAttachment(blob: Blob): Promise<UploadResult> {
  let dataBase64: string;
  try {
    dataBase64 = await blobToDataBase64(blob);
  } catch (err) {
    return { kind: 'error', status: 0, message: (err as Error).message || 'read failed' };
  }

  let res: Response;
  try {
    res = await fetch('/api/cockpit/notes/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit': '1', // localWriteGuard CSRF belt — exact header name
      },
      body: JSON.stringify({ dataBase64 }),
    });
  } catch (err) {
    return { kind: 'error', status: 0, message: (err as Error).message || 'network error' };
  }

  let body: UploadOkBody = {};
  try {
    body = (await res.json()) as UploadOkBody;
  } catch {
    /* empty/non-JSON body — handled by status switch below */
  }

  if (res.ok && body.path) {
    return {
      kind: 'ok',
      path: body.path,
      filename: body.filename ?? body.path.split('/').pop() ?? '',
      bytes: body.bytes ?? blob.size,
      sha256: body.sha256 ?? '',
    };
  }

  switch (res.status) {
    case 400:
      return { kind: 'invalid' };
    case 401:
      return { kind: 'auth' };
    case 409:
      return { kind: 'conflict' };
    case 413:
      return { kind: 'too-large' };
    case 415:
      return { kind: 'unsupported' };
    case 503:
      return { kind: 'disabled' };
    default:
      return {
        kind: 'error',
        status: res.status,
        message: body.error || body.message || `Server responded ${res.status}`,
      };
  }
}

// Calm, human inline message for a failed upload (no crash, no lost text).
export function uploadErrorMessage(result: Exclude<UploadResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'too-large':
      return 'That file is too large (images up to 10 MB, PDFs up to 20 MB).';
    case 'unsupported':
      return 'That file type isn’t supported (PNG, JPEG, GIF, WebP or PDF only).';
    case 'disabled':
      return 'File upload is currently disabled.';
    case 'auth':
      return 'Your session expired — reload to continue.';
    case 'invalid':
      return 'That file couldn’t be read.';
    case 'conflict':
      return 'Upload collided — try again.';
    default:
      return 'Couldn’t upload that file.';
  }
}
