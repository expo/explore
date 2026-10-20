import type {
  ActionKind,
  Controller,
  ElementBounds,
  ElementRole,
  InputElement,
} from "../types.js";
import { INPUT_METHOD_PACKAGES, keyboardNodes } from "./keyboard.js";

export type ControllerParseResult = {
  controller: Controller;
  format: "json" | "text";
  elements: InputElement[];
  warnings: string[];
};

const roleAliases: Record<string, ElementRole> = {
  button: "button",
  link: "link",
  tab: "tab",
  tabbaritem: "tab",
  input: "field",
  field: "field",
  textfield: "field",
  securetextfield: "field",
  searchfield: "field",
  search: "field",
  textbox: "field",
  switch: "toggle",
  checkbox: "toggle",
  toggle: "toggle",
  menuitem: "menu-item",
  cell: "menu-item",
  listitem: "menu-item",
  text: "text",
  statictext: "text",
  label: "text",
  heading: "text",
  header: "text",
  image: "image",
  icon: "image",
};

const actionableRoles = new Set<ElementRole>([
  "button",
  "link",
  "tab",
  "field",
  "toggle",
  "menu-item",
]);

const textValue = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

function roleFor(value: unknown): ElementRole {
  const normalized = textValue(value)?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (roleAliases[normalized]) return roleAliases[normalized];
  const suffix = Object.keys(roleAliases)
    .sort((left, right) => right.length - left.length)
    .find((alias) => normalized.endsWith(alias));
  return suffix ? roleAliases[suffix]! : "other";
}

function actionsFor(role: ElementRole): ActionKind[] {
  if (role === "field") return ["fill"];
  return actionableRoles.has(role) ? ["press"] : [];
}

function boundsFrom(value: unknown): ElementBounds | undefined {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, width, height] = value.map(Number);
    if ([x, y, width, height].every(Number.isFinite)) {
      return {
        x: x!,
        y: y!,
        width: width!,
        height: height!,
        unit: [x, y, width, height].every((number) => number! >= 0 && number! <= 1)
          ? "normalized"
          : "points",
      };
    }
  }
  if (typeof value === "string") {
    const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (numbers && numbers.length >= 4) {
      const [x, y, width, height] = numbers;
      return {
        x: x!,
        y: y!,
        width: width!,
        height: height!,
        unit: numbers.slice(0, 4).every((number) => number >= 0 && number <= 1)
          ? "normalized"
          : "points",
      };
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const origin = record.origin && typeof record.origin === "object"
    ? (record.origin as Record<string, unknown>)
    : record;
  const size = record.size && typeof record.size === "object"
    ? (record.size as Record<string, unknown>)
    : record;
  const x = Number(origin.x ?? record.left);
  const y = Number(origin.y ?? record.top);
  const width = Number(
    size.width ?? record.w ?? (record.maxX !== undefined ? Number(record.maxX) - x : Number(record.right) - x),
  );
  const height = Number(
    size.height ?? record.h ?? (record.maxY !== undefined ? Number(record.maxY) - y : Number(record.bottom) - y),
  );
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  const explicitUnit = textValue(record.unit);
  const unit = explicitUnit === "pixels" || explicitUnit === "points" || explicitUnit === "normalized"
    ? explicitUnit
    : [x, y, width, height].every((number) => number >= 0 && number <= 1)
      ? "normalized"
      : "points";
  return { x, y, width, height, unit };
}

function nodeToElement(node: Record<string, unknown>): InputElement | undefined {
  // The first field that names a known role wins. agent-device's host AX bridge reports the
  // native view class as `role` (RCTParagraphComponentView) and the element type as `type`
  // (StaticText), so reading only the first present field would make every bridge node `other`.
  const role = [
    node.role,
    node.accessibilityRole,
    node.AXRole,
    node.type,
    node.elementType,
    node.element_type,
    node.className,
    node.class,
  ].map(roleFor).find((candidate) => candidate !== "other") ?? "other";
  const label = textValue(
    node.label ??
      node.accessibilityLabel ??
      node.accessibility_label ??
      node.name ??
      node.title ??
      node.text ??
      node.description ??
      node.contentDescription ??
      node["content-desc"] ??
      node.AXLabel,
  );
  const rawIdentifier = textValue(
    node.identifier ??
      node.accessibilityIdentifier ??
      node.accessibility_id ??
      node.resourceId ??
      node.resource_id ??
      node["resource-id"] ??
      node.testID ??
      node.testId ??
      node.AXIdentifier,
  );
  const identifier = rawIdentifier && !/^@e\d+$/i.test(rawIdentifier) ? rawIdentifier : undefined;
  const value = textValue(node.value ?? node.currentValue ?? node.checked ?? node.AXValue);
  const bounds = boundsFrom(node.bounds ?? node.frame ?? node.rect);
  if (!label && !identifier && role === "other") return undefined;
  const enabled = typeof node.enabled === "boolean"
    ? node.enabled
    : typeof node.disabled === "boolean"
      ? !node.disabled
      : undefined;
  const visible = typeof node.visible === "boolean"
    ? node.visible
    : typeof node.hidden === "boolean"
      ? !node.hidden
      : undefined;
  const reportedActions = Array.isArray(node.actions)
    ? node.actions
    : Array.isArray(node.availableActions)
      ? node.availableActions
      : [];
  const actions = [
    ...new Set([
      ...actionsFor(role),
      ...reportedActions
        .map((action) => textValue(action)?.toLowerCase())
        .map((action): ActionKind | undefined =>
          action === "tap" || action === "click" || action === "activate" || action === "press"
            ? "press"
            : action === "setvalue" || action === "type" || action === "fill"
              ? "fill"
              : undefined,
        )
        .filter((action): action is ActionKind => Boolean(action)),
    ]),
  ];
  const selector = identifier ? `id=${identifier}` : label ? `label=${label}` : undefined;
  return {
    ...(identifier ? { id: identifier, identifier } : {}),
    role,
    label: label ?? identifier ?? role,
    ...(value !== undefined ? { value } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(visible !== undefined ? { visible } : {}),
    ...(bounds ? { bounds } : {}),
    ...(selector ? { selector } : {}),
    actions,
    actionable: enabled !== false && visible !== false && actions.length > 0,
    risk: "unknown",
  };
}

/**
 * Android snapshots include the system UI that is drawn over the app: the status bar (whose
 * signal, battery and clock labels change between emulator sessions) and the on-screen keyboard.
 * Those nodes name their owning package; the app's own nodes name the app. Comparing them would
 * report emulator noise as app changes, so they are dropped. iOS nodes carry no package.
 */
const SYSTEM_UI_PACKAGES = new Set([
  "android",
  "com.android.systemui",
  ...INPUT_METHOD_PACKAGES,
]);

export function isSystemUiNode(node: Record<string, unknown>): boolean {
  const owner = textValue(node.bundleId ?? node.packageName ?? node.package);
  return owner !== undefined && SYSTEM_UI_PACKAGES.has(owner);
}

function collectJsonElements(value: unknown, output: InputElement[], seen: Set<unknown>): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectJsonElements(item, output, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  // iOS's software keyboard is system UI too, like Android's: its keys and its Emoji and Dictate buttons are not the
  // app's elements. A keyboard that rose on one side only made "Added button “Dictate”" lead a review whose real
  // change was a field's label (brentvatne/euxy#172, review run 39362642343).
  if (Array.isArray(record.nodes)) {
    for (const node of keyboardNodes(record.nodes.filter((node): node is Record<string, unknown> => !!node && typeof node === "object" && !Array.isArray(node)))) seen.add(node);
  }
  const element = isSystemUiNode(record) ? undefined : nodeToElement(record);
  if (element) output.push(element);
  for (const [key, child] of Object.entries(record)) {
    if (["bounds", "frame", "rect", "origin", "size"].includes(key)) continue;
    if (child && typeof child === "object") collectJsonElements(child, output, seen);
  }
}

function parseTextBounds(line: string): ElementBounds | undefined {
  const match = line.match(
    /(?:x|left)\s*[=:]\s*(-?\d+(?:\.\d+)?).*?(?:y|top)\s*[=:]\s*(-?\d+(?:\.\d+)?).*?(?:width|w)\s*[=:]\s*(\d+(?:\.\d+)?).*?(?:height|h)\s*[=:]\s*(\d+(?:\.\d+)?)/i,
  );
  const tuple = line.match(
    /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*$/,
  );
  if (!match && !tuple) return undefined;
  const [, rawX, rawY, rawWidth, rawHeight] = match ?? tuple!;
  const values = [rawX, rawY, rawWidth, rawHeight].map(Number);
  if (!values.every(Number.isFinite)) return undefined;
  const [x, y, width, height] = values as [number, number, number, number];
  return {
    x,
    y,
    width,
    height,
    unit: values.every((number) => number >= 0 && number <= 1) ? "normalized" : "points",
  };
}

function parseTextElements(raw: string, warnings: string[]): InputElement[] {
  const elements: InputElement[] = [];
  const collapseAdjacentDuplicates =
    /private-ax snapshot backend|possible repeated nav subtree detected/i.test(raw);
  if (/content below scroll-area hidden/i.test(raw)) {
    warnings.push(
      "Accessibility output hides content below a scrollable container; add a swipe frontier and capture the remaining content",
    );
  }
  const lines = raw.split(/\r?\n/);
  let insideTabBar = false;
  let tabBarBounds: ElementBounds | undefined;
  let lastCandidate: InputElement | undefined;
  let collapsedDuplicates = 0;
  let ambiguousBoundlessTabButtons = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || /^ROOT\b/i.test(trimmed)) {
      continue;
    }
    const bracketRole = trimmed.match(/(?:@e\d+\s+)?\[([^\]]+)]/)?.[1];
    const prefixedRole = trimmed.match(
      /^(?:@e\d+\s+)?(AX[A-Za-z]+|Application|Button|Link|Tab|TabBarItem|TextField|SecureTextField|SearchField|Switch|Checkbox|Cell|StaticText|Text|Image|Group)\b/i,
    )?.[1];
    const explicitRole = bracketRole ?? prefixedRole;
    if (!explicitRole) continue;
    const baseRole = roleFor(explicitRole);
    const quoted = trimmed.match(/"([^"]+)"/) ?? trimmed.match(/'([^']+)'/);
    const rawIdentifier = trimmed.match(/\b(?:identifier|id|testID|resource-id)\s*[=:]\s*["']?([^,"'\]\s]+)/i)?.[1];
    const identifier = rawIdentifier && !/^@e\d+$/i.test(rawIdentifier) ? rawIdentifier : undefined;
    const bounds = parseTextBounds(trimmed);
    const inheritsParentLabel = /same label as parent/i.test(trimmed);
    const explicitLabel = inheritsParentLabel
      ? lastCandidate?.label
      : quoted?.[1]?.trim() ?? identifier;
    if (inheritsParentLabel && !explicitLabel) {
      warnings.push("A controller element referenced a missing parent label and could not be preserved");
      continue;
    }
    if (!explicitLabel && !bounds) continue;
    const label = explicitLabel ?? baseRole;
    const normalizedExplicitRole = explicitRole.toLowerCase().replace(/[^a-z]/g, "");
    const startsTabBar =
      normalizedExplicitRole === "tabbar" ||
      (normalizedExplicitRole === "axgroup" && label.toLowerCase() === "tab bar");
    if (startsTabBar) {
      insideTabBar = true;
      tabBarBounds = bounds;
    } else if (insideTabBar && baseRole !== "button") {
      const nextElementLine = lines
        .slice(lineIndex + 1)
        .map((candidate) => candidate.trim())
        .find((candidate) =>
          /(?:@e\d+\s+)?\[[^\]]+]|^(?:@e\d+\s+)?AX[A-Za-z]+\b/i.test(candidate),
        );
      const nextRole = nextElementLine?.match(/(?:@e\d+\s+)?\[([^\]]+)]/)?.[1] ??
        nextElementLine?.match(/^(?:@e\d+\s+)?(AX[A-Za-z]+)\b/i)?.[1];
      const nextLabel = nextElementLine?.match(/"([^"]+)"/)?.[1]?.trim() ??
        nextElementLine?.match(/'([^']+)'/)?.[1]?.trim();
      const isPairedTabLabel =
        baseRole === "other" && roleFor(nextRole) === "button" && nextLabel === label;
      if (!isPairedTabLabel) {
        insideTabBar = false;
        tabBarBounds = undefined;
      }
    }
    const comparableTabBounds = Boolean(
      tabBarBounds && bounds && tabBarBounds.unit === bounds.unit,
    );
    const insideTabBarFrame = Boolean(
      comparableTabBounds &&
      tabBarBounds &&
      bounds &&
      bounds.x >= tabBarBounds.x &&
        bounds.y >= tabBarBounds.y &&
        bounds.x + bounds.width <= tabBarBounds.x + tabBarBounds.width &&
        bounds.y + bounds.height <= tabBarBounds.y + tabBarBounds.height,
    );
    if (
      insideTabBar &&
      baseRole === "button" &&
      tabBarBounds &&
      bounds &&
      !insideTabBarFrame
    ) {
      insideTabBar = false;
      tabBarBounds = undefined;
    }
    const explicitlySelected = /\bselected\b/i.test(trimmed);
    const boundedTab =
      insideTabBar &&
      baseRole === "button" &&
      insideTabBarFrame &&
      Boolean(bounds && bounds.width <= 0.5);
    const selectedBoundlessTab =
      insideTabBar &&
      baseRole === "button" &&
      explicitlySelected &&
      !comparableTabBounds;
    const role = boundedTab || selectedBoundlessTab ? "tab" : baseRole;
    if (
      insideTabBar &&
      baseRole === "button" &&
      role !== "tab" &&
      !comparableTabBounds
    ) {
      ambiguousBoundlessTabButtons += 1;
    }
    const enabled = /\bdisabled\b/i.test(trimmed) ? false : undefined;
    const actions = actionsFor(role);
    const element: InputElement = {
      ...(identifier ? { id: identifier, identifier } : {}),
      role,
      label,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(bounds ? { bounds } : {}),
      ...(identifier
        ? { selector: `id=${identifier}` }
        : explicitLabel
          ? { selector: `label=${label}` }
          : {}),
      actions,
      actionable: enabled !== false && actions.length > 0,
      risk: "unknown",
    };
    lastCandidate = element;
    const previous = elements.at(-1);
    if (
      collapseAdjacentDuplicates &&
      previous &&
      elementSignature(previous) === elementSignature(element)
    ) {
      collapsedDuplicates += 1;
      continue;
    }
    elements.push(element);
  }
  if (collapsedDuplicates > 0) {
    warnings.push(
      `Collapsed ${collapsedDuplicates} adjacent duplicate element(s) from controller output; verify the corrected element inventory`,
    );
  }
  if (ambiguousBoundlessTabButtons > 0) {
    warnings.push(
      `Retained ${ambiguousBoundlessTabButtons} boundless button(s) after a boundless tab bar as buttons because tab membership was ambiguous`,
    );
  }
  return elements;
}

function elementSignature(element: InputElement): string {
  return JSON.stringify({
    id: element.id,
    identifier: element.identifier,
    role: element.role,
    label: element.label,
    value: element.value,
    enabled: element.enabled,
    visible: element.visible,
    bounds: element.bounds,
    selector: element.selector,
    actions: element.actions,
    actionable: element.actionable,
  });
}

function dedupeExactElements(elements: InputElement[], warnings: string[]): InputElement[] {
  const seen = new Set<string>();
  let duplicateCount = 0;
  const result = elements.filter((element) => {
    const signature = elementSignature(element);
    if (seen.has(signature)) {
      duplicateCount += 1;
      return false;
    }
    seen.add(signature);
    return true;
  });
  if (duplicateCount > 0) {
    warnings.push(
      `Collapsed ${duplicateCount} exact duplicate JSON element(s); verify the corrected element inventory`,
    );
  }
  return result;
}

function addOccurrences(elements: InputElement[]): InputElement[] {
  const counts = new Map<string, number>();
  return elements.map((element) => {
    const key = `${element.role ?? "other"}\0${element.label?.toLowerCase() ?? ""}\0${element.selector ?? ""}`;
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    return { ...element, occurrence };
  });
}

export function parseControllerOutput(controller: Controller, raw: string): ControllerParseResult {
  const warnings: string[] = [];
  let format: ControllerParseResult["format"] = "text";
  let elements: InputElement[] = [];
  let collectedJsonTree = false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    format = "json";
    const description =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? textValue((parsed as Record<string, unknown>).description)
        : undefined;
    if (description) elements = parseTextElements(description, warnings);
    if (elements.length === 0) {
      collectJsonElements(parsed, elements, new Set());
      collectedJsonTree = true;
    }
  } catch {
    elements = parseTextElements(raw, warnings);
  }
  elements = addOccurrences(collectedJsonTree ? dedupeExactElements(elements, warnings) : elements);
  if (elements.length === 0) {
    warnings.push(`No UI elements could be parsed from ${controller} output`);
  }
  if (elements.some((element) => element.actionable && !element.selector && !element.bounds)) {
    warnings.push("Some actionable elements have neither a semantic selector nor controller bounds");
  }
  return { controller, format, elements, warnings };
}
