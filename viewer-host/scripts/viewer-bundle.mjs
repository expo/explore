import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function relativeUrlPath(value) {
  const withoutQuery = value.split(/[?#]/, 1)[0];
  if (!withoutQuery?.startsWith("/viewer/")) return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery.slice("/viewer/".length));
  } catch {
    return undefined;
  }
  if (!decoded || decoded.startsWith("/") || decoded.includes("\\")) return undefined;
  const normalized = posix.normalize(decoded);
  return normalized === decoded && !normalized.startsWith("../") ? normalized : undefined;
}

async function collectFiles(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) throw new Error(`Viewer bundle contains a symlink: ${relativePath}`);
      if (stats.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Viewer bundle contains a non-file entry: ${relativePath}`);
      files.push({ relativePath, absolutePath, bytes: stats.size });
      if (files.length > MAX_FILES) throw new Error(`Viewer bundle exceeds ${MAX_FILES} files`);
    }
  }
  await visit(root);
  return files;
}

export async function inspectViewerBundle(directory, label = "Viewer bundle") {
  const root = resolve(directory);
  const files = await collectFiles(root);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`${label} exceeds ${MAX_TOTAL_BYTES} bytes`);

  const paths = new Set(files.map(file => file.relativePath));
  if (!paths.has("index.html")) throw new Error(`${label} is missing index.html`);
  const javascript = files.filter(file => file.relativePath.endsWith(".js"));
  const stylesheets = files.filter(file => file.relativePath.endsWith(".css"));
  if (javascript.length < 1 || stylesheets.length < 1) {
    throw new Error(`${label} must contain compiled JavaScript and CSS assets`);
  }

  const indexHtml = await readFile(join(root, "index.html"), "utf8");
  if (indexHtml.includes("Viewer bundle unavailable")) {
    throw new Error(`${label} is still the fail-closed placeholder`);
  }
  if (/\b(?:src|href)=["']\/assets\//i.test(indexHtml)) {
    throw new Error(`${label} contains a root /assets URL instead of the /viewer/ base`);
  }
  const references = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map(match => match[1]);
  const compiledReferences = references.filter(value => /\.(?:css|js)(?:[?#]|$)/i.test(value));
  if (compiledReferences.length < 2) {
    throw new Error(`${label} index does not reference compiled JavaScript and CSS`);
  }
  for (const reference of compiledReferences) {
    const relativePath = relativeUrlPath(reference);
    if (!relativePath || !paths.has(relativePath)) {
      throw new Error(`${label} has an invalid or missing /viewer/ asset reference: ${reference}`);
    }
  }

  const inventory = [];
  let includesSameOriginCredentials = false;
  for (const file of files) {
    const contents = await readFile(file.absolutePath);
    if (file.relativePath.endsWith(".js") || file.relativePath.endsWith(".css")) {
      if (contents.includes(Buffer.from("/assets/"))) {
        throw new Error(`${label} contains a stale root /assets/ reference in ${file.relativePath}`);
      }
      const text = contents.toString("utf8");
      if (file.relativePath.endsWith(".js") && /credentials:["']same-origin["']/.test(text)) {
        includesSameOriginCredentials = true;
      }
      for (const match of text.matchAll(/\/viewer\/[A-Za-z0-9._~@+=,%/-]+/g)) {
        const reference = match[0];
        const relativePath = relativeUrlPath(reference);
        if (!relativePath || !paths.has(relativePath)) {
          throw new Error(`${label} references a missing Viewer asset in ${file.relativePath}: ${reference}`);
        }
      }
    }
    inventory.push({
      path: file.relativePath,
      bytes: file.bytes,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  if (!includesSameOriginCredentials) {
    throw new Error(`${label} does not send the HttpOnly session for same-origin workspace fetches`);
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(inventory))
    .digest("hex");
  return { root, files: inventory, totalBytes, digest };
}

export function assertSameViewerBundle(left, right, label = "Staged Viewer") {
  if (left.digest !== right.digest || JSON.stringify(left.files) !== JSON.stringify(right.files)) {
    throw new Error(`${label} does not exactly match the freshly built Viewer dist`);
  }
}

export function isPathInside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  return target.startsWith(`${root}${sep}`);
}
