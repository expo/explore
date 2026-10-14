import type { Screen } from "../../../src/types";
import { displayPathForScreen } from "./screen-path";

export type SearchItemKind = "screen";

export type SearchItem = {
  id: string;
  kind: SearchItemKind;
  title: string;
  keywords: string[];
  context: string;
  order: number;
  route?: string;
  screenId?: string;
};

export type SearchSuggestionContext = {
  screenId?: string;
};

const KIND_ORDER: Record<SearchItemKind, number> = { screen: 0 };

export function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function resultScore(item: SearchItem, query: string): number | undefined {
  const title = normalizeSearchText(item.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 2;
  if (title.includes(query)) return 3;
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
  return items
    .flatMap((item) => {
      const score = resultScore(item, query);
      return score === undefined ? [] : [{ item, score }];
    })
    .sort((left, right) => (
      left.score - right.score
      || KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind]
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
