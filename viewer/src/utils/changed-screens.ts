import type { BuildDiff, DiffStatus, ScreenDiff } from "./build-diff";
import type { MapIndex } from "./model";
import { isLaunchScreen } from "./model";
import type { FocusStatus } from "./navigation";
import { displayPathForScreen } from "./screen-path";

const STATUS_ORDER: Record<FocusStatus, number> = {
  added: 0,
  modified: 1,
  removed: 2,
  "needs-review": 3,
  "source-affected": 4,
};

export type ChangedScreen = {
  id: string;
  status: FocusStatus;
  title: string;
  route: string;
};

export function isChangedStatus(status: DiffStatus): status is FocusStatus {
  return status !== "unchanged" && status !== "not-compared" && status !== "unavailable" && status !== "variant";
}

/**
 * A change the captures show: an added, removed or modified screen, including one modified only in what assistive
 * technology reads (its screenshots match, its accessibility tree does not). A screen whose source changed but whose
 * captures show nothing different ("No visible change", source-affected) stays in the Changes list, but Compare does
 * not step through it and Screens' Changed hides it.
 */
export function isCapturedChange(diff: Pick<ScreenDiff, "status"> | undefined): boolean {
  return diff !== undefined && (diff.status === "added" || diff.status === "removed" || diff.status === "modified");
}

export function compareText(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFKD").toLocaleLowerCase("en-US");
  const normalizedRight = right.normalize("NFKD").toLocaleLowerCase("en-US");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareChangedScreens(left: ChangedScreen, right: ChangedScreen): number {
  // The launch is reviewed before the screens the app shows afterwards, whatever its verdict.
  return Number(isLaunchScreen(right)) - Number(isLaunchScreen(left))
    || STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || compareText(left.route, right.route)
    || compareText(left.title, right.title)
    || compareText(left.id, right.id);
}

/** Every changed screen in review order: by status, then by route. The Changes list uses it too. */
export function changedScreens(diff: BuildDiff, index: MapIndex): ChangedScreen[] {
  const result: ChangedScreen[] = [];
  for (const [id, screenDiff] of diff.screens) {
    if (!isChangedStatus(screenDiff.status)) continue;
    const screen = index.screens.get(id);
    if (!screen) continue;
    result.push({ id, status: screenDiff.status, title: screen.title, route: displayPathForScreen(screen) });
  }
  return result.sort(compareChangedScreens);
}
