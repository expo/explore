import { useEffect, useRef } from "react";

const FOCUSABLE = [
  'button:not(:disabled):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([type="hidden"]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Escape to close, Tab wrapped inside the dialog, focus restored to the opener unless what closed it moved focus on. */
export function useModalDialog(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (document.activeElement === document.body || dialog?.contains(document.activeElement)) (restoreFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  return dialogRef;
}
