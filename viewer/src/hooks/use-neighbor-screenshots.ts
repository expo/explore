import { useEffect, useRef } from "react";
import type { BuildDiff } from "../utils/build-diff";
import type { ChangedScreen } from "../utils/changed-screens";
import { isEmbeddedArtifactUrl, leaseEmbeddedArtifactUrl } from "../utils/embedded-report";
import type { KeyHold } from "../utils/key-hold";

/** How long Compare rests on a screen before it reads the next one's screenshots. */
export const NEIGHBOR_SETTLE_MS = 250;

export type NeighborScreenshotsOptions = {
  diff: BuildDiff;
  order: readonly ChangedScreen[];
  screenId: string;
  /** Compare steps between screens; the Inspector, which stays on its screen, reads no neighbour. */
  enabled: boolean;
  /** The keys that step: no neighbour is read while one is held. */
  hold: KeyHold;
};

/**
 * Reads the screenshots of the screen Compare would step to next, in the direction it last stepped (by key, the
 * header's buttons, a tap or the picker), once it has rested on a screen. The next step usually finds them decoded,
 * so its pictures fade in within a frame of the step. Each is one use of the report's screenshot until Compare moves
 * on, then released; nothing is decoded outside the page's own images.
 *
 * A held key steps past screens faster than they could be read, so nothing is read until it is released. The reads
 * are the report's prefetches: one starts only while two slots stay free for the step the reviewer takes, so
 * speculative work never holds more than two, whatever earlier prefetches are still reading, and one that has not
 * started when Compare moves on is dropped unread.
 */
export function useNeighborScreenshots({ diff, order, screenId, enabled, hold }: NeighborScreenshotsOptions) {
  const position = order.findIndex((entry) => entry.id === screenId);
  const last = useRef<{ position: number; direction: 1 | -1 }>({ position, direction: 1 });
  useEffect(() => {
    if (!enabled || position < 0) return;
    const previous = last.current;
    const direction = position === previous.position ? previous.direction : position > previous.position ? 1 : -1;
    last.current = { position, direction };
    const neighbor = order[position + direction];
    const screen = neighbor ? diff.screens.get(neighbor.id) : undefined;
    const sources = new Set([screen?.beforeScreenshot, screen?.afterScreenshot]
      .filter((source): source is string => Boolean(source && isEmbeddedArtifactUrl(source))));
    if (sources.size === 0) return;
    const leases: { release: () => boolean; held: boolean }[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const read = () => {
      if (hold.holding()) {
        timer = setTimeout(read, NEIGHBOR_SETTLE_MS);
        return;
      }
      for (const source of sources) {
        const leased = leaseEmbeddedArtifactUrl(source, "prefetch");
        const lease = { release: leased.release, held: true };
        leases.push(lease);
        // A read that failed (a report switched away from, or a prefetch dropped) holds nothing to release.
        void leased.url.catch(() => { lease.held = false; });
      }
    };
    timer = setTimeout(read, NEIGHBOR_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      for (const lease of leases) if (lease.held) lease.release();
    };
  }, [enabled, position, order, diff, hold]);
}
