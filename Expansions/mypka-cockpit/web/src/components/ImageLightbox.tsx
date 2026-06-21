// ImageLightbox.tsx — the shared lightbox-lite for /api/cockpit/media images.
//
// Extracted from JournalView's timeline so the universal note viewer can reuse
// it. A fixed overlay <img> rendered via createPortal to document.body — the
// portal is load-bearing: it cures the documented animate-fade-rise
// containing-block bug (a transformed ancestor would otherwise trap the
// position:fixed overlay inside the view).
//
// Behaviour (house idiom, unchanged from the timeline original):
//   - Esc or any click closes; body scroll-lock via .overlay-open while open.
//   - Focus lands on the close button on open and returns to the
//     previously-focused element (the thumbnail) on close.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './image-lightbox.css';

export function ImageLightbox({ path, alt, onClose }: { path: string; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, []);

  // Esc closes; body scroll-lock while open (house idiom). Owned here so every
  // consumer gets identical behaviour without re-wiring a view-level effect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('overlay-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('overlay-open');
    };
  }, [onClose]);

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <img
        className="image-lightbox-img"
        src={`/api/cockpit/media?path=${encodeURIComponent(path)}`}
        alt={alt}
      />
      <button
        ref={closeRef}
        type="button"
        className="image-lightbox-close"
        onClick={onClose}
        aria-label="Close image"
      >
        <X size={18} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
