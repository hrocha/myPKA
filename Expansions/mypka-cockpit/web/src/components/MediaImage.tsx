// MediaImage.tsx — renders a journal/PKM image from the read-only media route.
// Graceful degradation: if the file is missing on disk (the mirror knows the
// path but the bytes may not be present), we show a calm placeholder + caption
// instead of a broken <img>. Never a broken image icon.
import { useState } from 'react';
import { ImageOff } from 'lucide-react';

export function MediaImage({ path, caption }: { path: string; caption: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/cockpit/media?path=${encodeURIComponent(path)}`;
  const name = path.split('/').pop() ?? path;

  if (failed) {
    return (
      <figure className="media-missing">
        <div className="media-missing-box" aria-hidden="true">
          <ImageOff size={20} strokeWidth={1.5} />
        </div>
        <figcaption>
          {caption || name}
          <span className="media-missing-note">Image not found on disk</span>
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className="media-figure">
      <img
        src={src}
        alt={caption || name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
