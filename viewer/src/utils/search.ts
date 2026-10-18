import type { Screen } from "../../../src/types";
import { displayPathForScreen } from "./screen-path";

export type SearchItemKind = "screen" | "command";

export type SearchItem = {
  id: string;
  kind: SearchItemKind;
  title: string;
  keywords: string[];
  context: string;
  order: number;
  route?: string;
  screenId?: string;
  /** Commands: the key that also runs it, printed, and what it does. */
  shortcut?: string;
  run?: () => void;
};

export type SearchSuggestionContext = {
  screenId?: string;
};

/** Route-shaped queries ("/settings") are after a screen; words ("dark", "fit") are after a command. */
function preferredKind(query: string): SearchItemKind {
  return query.startsWith("/") ? "screen" : "command";
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function resultScore(item: SearchItem, query: string): number | undefined {
  const title = normalizeSearchText(item.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 2;
  if (title.includes(query)) return 3;
  if (item.keywords.some((keyword) => normalizeSearchText(keyword).includes(query))) return 4;
  if (item.route && normalizeSearchText(item.route).includes(query)) return 4;
  return undefined;
}

export function searchItems(
  items: readonly SearchItem[],
  rawQuery: string,
  limit = 50,
): SearchItem[] {
  const query = normalizeSearchText(rawQuery);
  if (!query || limit <= 0) return [];
  const preferred = preferredKind(query);
  const kindOrder = (item: SearchItem) => (item.kind === preferred ? 0 : 1);
  return items
    .flatMap((item) => {
      const score = resultScore(item, query);
      return score === undefined ? [] : [{ item, score }];
    })
    .sort((left, right) => (
      left.score - right.score
      || kindOrder(left.item) - kindOrder(right.item)
      || left.item.order - right.item.order
      || left.item.title.localeCompare(right.item.title)
      || left.item.id.localeCompare(right.item.id)
    ))
    .slice(0, limit)
    .map(({ item }) => item);
}

export function buildSearchItems(input: { screens: readonly Screen[] }): SearchItem[] {
  return input.screens.map<SearchItem>((screen, order) => {
    const path = displayPathForScreen(screen);
    return { id: `screen:${screen.id}`, kind: "screen", title: path, keywords: [path], context: "", order, screenId: screen.id };
  });
}

export function suggestedSearchItems(
  items: readonly SearchItem[],
  context: SearchSuggestionContext,
  limit = 12,
): SearchItem[] {
  if (limit <= 0) return [];
  const selectedScreen = context.screenId
    ? items.find((item) => item.kind === "screen" && item.screenId === context.screenId)
    : undefined;
  const output: SearchItem[] = [];
  const seen = new Set<string>();
  const add = (item: SearchItem | undefined) => {
    if (!item || output.length >= limit || seen.has(item.id)) return;
    seen.add(item.id);
    output.push(item);
  };

  add(selectedScreen);
  // The inventory fills the rest, in Screens order.
  items.forEach(add);

  return output.slice(0, limit);
}
