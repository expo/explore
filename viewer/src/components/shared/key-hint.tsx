import { heldKeyHint, useHeldModifiers } from "../../utils/held-modifiers";
import type { Shortcut } from "../../utils/shortcuts";

/**
 * The key that completes a chord, shown on a button's corner while the chord's modifiers are
 * held. Hold ⌃ and the toolbar's sections show 1, 2 and 3; release it and they are gone.
 * Nothing renders for a plain key or while nothing is held.
 */
export function KeyHint({ shortcut }: { shortcut: Shortcut }) {
  const held = useHeldModifiers();
  const key = heldKeyHint(shortcut, held);
  if (!key) return null;
  return <kbd className="key-hint" aria-hidden="true">{key}</kbd>;
}
