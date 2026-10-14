/** Small HTML helpers shared by the pull-request comment renderers. GitHub renders this HTML inline. */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("|", "&#124;");
}

export type ScreenshotCell = {
  /** Already-validated HTTPS image URL. */
  imageUrl: string;
  /** Already-validated link that opens this surface in the Viewer. */
  href: string;
  /** Plain text; escaped here. */
  route: string;
  /** Plain text; escaped here. */
  description: string;
};

/**
 * A fixed-column screenshot grid. Each cell is one captured surface: the screenshot, the route as a
 * link into the Viewer, and one deterministic description line.
 */
export function renderScreenshotGrid(cells: readonly ScreenshotCell[], columns = 3): string[] {
  if (cells.length === 0) return [];
  const width = `${Math.floor(100 / columns)}%`;
  const rows: string[] = ["<table>"];
  for (let start = 0; start < cells.length; start += columns) {
    rows.push("<tr>");
    for (const cell of cells.slice(start, start + columns)) {
      const route = escapeHtml(cell.route);
      rows.push(
        `<td align="center" valign="top" width="${width}">`
        + `<a href="${escapeHtml(cell.href)}"><img src="${escapeHtml(cell.imageUrl)}" width="180" alt="${route}"></a><br>`
        + `<a href="${escapeHtml(cell.href)}"><code>${route}</code></a><br>`
        + `<sub>${escapeHtml(cell.description)}</sub>`
        + "</td>",
      );
    }
    rows.push("</tr>");
  }
  rows.push("</table>");
  return rows;
}

export type RouteListItem = {
  href: string;
  route: string;
  description?: string;
};

/** Blank lines keep route items in separate paragraphs when GitHub renders the list. */
/** Every group reads the same: an HTML list whose items carry a paragraph's spacing,
    so a one-route group is laid out exactly like a many-route one. */
export function renderRouteList(items: readonly RouteListItem[]): string[] {
  if (items.length === 0) return [];
  return [
    "<ul>",
    ...items.map((item) => (
      `<li><p><a href="${escapeHtml(item.href)}"><code>${escapeHtml(item.route)}</code></a>`
      + (item.description ? ` — ${escapeHtml(item.description)}` : "")
      + "</p></li>"
    )),
    "</ul>",
  ];
}

/** A short line of prose inside a details block, which holds HTML rather than Markdown. */
export function renderNote(text: string, anchor?: { label: string; href: string }): string {
  const suffix = anchor ? ` — <a href="${escapeHtml(anchor.href)}">${escapeHtml(anchor.label)}</a>` : "";
  return `<p>${escapeHtml(text)}${suffix}</p>`;
}
