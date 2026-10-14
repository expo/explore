import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { ScreenshotImage } from "./screenshot-image";
import "./image-lightbox.css";

export type LightboxImage = {
  src: string;
  alt: string;
  /** Shown above the image, such as "Before" or "After". */
  label?: string;
};

/**
 * A full-window image view. With more than one image, the left and right arrow keys and the
 * side buttons move between them, so a Before and After pair can be flipped in place. The native
 * modal dialog keeps Escape and focus inside it.
 */
export function ImageLightbox(props: { images: readonly LightboxImage[]; initialIndex?: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, props.initialIndex ?? 0), props.images.length - 1));
  const image = props.images[index];
  const multiple = props.images.length > 1;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  if (!image) return null;
  const dismiss = () => { dialog.current?.close(); props.onClose(); };
  const move = (step: number) => setIndex((current) => Math.min(Math.max(0, current + step), props.images.length - 1));
  return createPortal(
    <dialog
      ref={dialog}
      className="image-lightbox"
      aria-label={image.label ? `${image.label} screenshot` : image.alt || "Image preview"}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (!multiple) return;
        if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
        if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <div className="image-lightbox-bar">
        {image.label ? <span className="image-lightbox-label">{image.label}</span> : <span />}
        {multiple ? (
          <span className="image-lightbox-position">{index + 1} of {props.images.length} · ← →</span>
        ) : null}
        <button type="button" className="image-lightbox-close" aria-label="Close image preview" onClick={dismiss}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="image-lightbox-stage">
        {multiple ? (
          <button type="button" className="image-lightbox-step" aria-label="Previous image"
            disabled={index === 0} onClick={() => move(-1)}>
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : null}
        <ScreenshotImage key={image.src} src={image.src} alt={image.alt} loading="eager" draggable={false} />
        {multiple ? (
          <button type="button" className="image-lightbox-step" aria-label="Next image"
            disabled={index === props.images.length - 1} onClick={() => move(1)}>
            <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}
