import type { ConnectionGroup } from "./graph-model";

export type MapKeyDirection = "up" | "down" | "left" | "right";
type Point = { x: number; y: number };

/** Arrow keys and their Vim twins; anything else is not a map move. */
export function mapKeyDirection(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): MapKeyDirection | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  switch (event.key) {
    case "ArrowUp": case "k": case "K": return "up";
    case "ArrowDown": case "j": case "J": return "down";
    case "ArrowLeft": case "h": case "H": return "left";
    case "ArrowRight": case "l": case "L": return "right";
    default: return undefined;
  }
}

/**
 * The screen a key moves the selection to, read off the drawn map like the arrow keys on a grid:
 * the screen that lies in the key's direction from the selected one. A screen it is connected
 * to wins over an unconnected neighbour; among those, the one most squarely in that direction.
 * Nothing in that direction leaves the selection where it is.
 */
export function mapKeyTarget(
  structure: { positions: Map<string, Point>; groups: readonly ConnectionGroup[]; horizontal?: boolean },
  selectedId: string,
  direction: MapKeyDirection,
): string | undefined {
  const origin = structure.positions.get(selectedId);
  if (!origin) return undefined;
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "down" || direction === "right" ? 1 : -1;
  // How far ahead a screen is, and how far it drifts sideways; both in map units.
  const ahead = (point: Point) => sign * (vertical ? point.y - origin.y : point.x - origin.x);
  const drift = (point: Point) => Math.abs(vertical ? point.x - origin.x : point.y - origin.y);
  const linked = new Set<string>();
  for (const group of structure.groups) {
    if (group.from === selectedId) linked.add(group.to);
    if (group.to === selectedId) linked.add(group.from);
  }
  // A linked screen may sit well off the axis (a fan-out's children are drawn diagonally from
  // their source); an unlinked one must lie squarely in the key's direction, and it yields to a
  // linked screen up to half as far again. Sideways drift counts double against a candidate.
  let best: { id: string; score: number } | undefined;
  for (const [id, point] of structure.positions) {
    if (id === selectedId) continue;
    const forward = ahead(point);
    const spread = linked.has(id) ? 2 : 0.5;
    if (forward <= 0 || drift(point) > forward * spread) continue;
    const score = (forward + drift(point) * 2) * (linked.has(id) ? 1 : 1.5);
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id;
}

/**
 * The screen an arrow selects when nothing is: the one at the edge the key moves away from, as
 * the Screens page's arrows enter at the first or last card. ↓ takes the topmost screen, ↑ the
 * bottom one, → the leftmost, ← the rightmost; ties go to the screen nearest the other axis's start.
 */
export function mapKeyEntry(
  structure: { positions: Map<string, Point> },
  direction: MapKeyDirection,
): string | undefined {
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "down" || direction === "right" ? 1 : -1;
  let best: { id: string; along: number; across: number } | undefined;
  for (const [id, point] of structure.positions) {
    const along = sign * (vertical ? point.y : point.x);
    const across = vertical ? point.x : point.y;
    if (!best || along < best.along || (along === best.along && across < best.across)) best = { id, along, across };
  }
  return best?.id;
}
