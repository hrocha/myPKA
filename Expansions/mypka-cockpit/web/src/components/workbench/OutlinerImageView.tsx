// OutlinerImageView.tsx — the TipTap React node view for an outliner image.
//
// The node stores the RELATIVE path in `src` (e.g. `_attachments/<uuid>.png`) —
// the same value serialized to markdown. The DISPLAY url is resolved HERE, at
// render time only, to the read-only, jailed, inert media route:
//   _attachments/<uuid>.<ext>  →  /api/cockpit/file?path=Fleeting%20Notes/<relative>
// (Mack's serve contract). We never persist the absolute/display url.
//
// While `uploading` is true we show a calm optimistic placeholder (no image src
// yet). A load failure degrades to a calm inline notice — never a broken-image
// glyph, never a crash, never lost surrounding text.
import { useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { ImageOff, Loader2 } from 'lucide-react';
import { workbenchAttachmentSrc } from '../../lib/workbenchAttachments';
import { OutlinerImage } from '../../lib/outlinerSchema';

export function OutlinerImageView({ node, selected }: NodeViewProps) {
  const [failed, setFailed] = useState(false);
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const uploading = node.attrs.uploading === true;

  if (uploading) {
    return (
      <NodeViewWrapper
        as="figure"
        className="wb-img wb-img--uploading"
        contentEditable={false}
        data-selected={selected ? 'true' : undefined}
      >
        <div className="wb-img-placeholder" aria-label="Uploading image" role="img">
          <Loader2 className="wb-img-spinner" size={20} strokeWidth={1.5} aria-hidden="true" />
        </div>
      </NodeViewWrapper>
    );
  }

  if (failed || !src) {
    return (
      <NodeViewWrapper
        as="figure"
        className="wb-img wb-img--missing"
        contentEditable={false}
        data-selected={selected ? 'true' : undefined}
      >
        <div className="wb-img-placeholder" aria-hidden="true">
          <ImageOff size={20} strokeWidth={1.5} />
        </div>
        <figcaption className="wb-img-missing-note">
          {alt || src.split('/').pop() || 'Image'} — couldn’t load
        </figcaption>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="figure"
      className="wb-img"
      contentEditable={false}
      data-selected={selected ? 'true' : undefined}
    >
      <img
        className="wb-img-el"
        src={workbenchAttachmentSrc(src)}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </NodeViewWrapper>
  );
}

// The image node spec (from the schema) with its React node view attached. This
// is the version passed into outlinerExtensions(); the bare OutlinerImage stays
// render-agnostic in the lib layer.
export const OutlinerImageNode = OutlinerImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(OutlinerImageView);
  },
});
