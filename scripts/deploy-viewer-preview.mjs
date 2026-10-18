// Deploys this checkout's hosted Viewer (dist/hosting-preview) with the fixture reports to a fixed EAS Hosting alias,
// so a pull request in this repository can be reviewed on real data. Prints the deployment as JSON.
//
//   node scripts/deploy-viewer-preview.mjs --fixtures DIR --alias pr-123 --project explore-viewer-pr [--owner expo-public]
//
// DIR holds reports.json ([{ target?, platform, label?, changes?, device? }], as a hosted preview's /reports.json lists
// them) and one <target>.zip per entry, or <platform>.zip for an entry without a target
// (scripts/refresh-viewer-preview-fixtures.sh writes both). EXPLORE_PREVIEW_TOKEN keeps an earlier link's /p/<token>;
// without it the link gets a new one. EXPO_TOKEN must be able to deploy to the project.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deployFixturePreview, fixtureReports } from "../dist/report/preview-deploy.js";

const { values } = parseArgs({ options: { fixtures: { type: "string" }, alias: { type: "string" }, project: { type: "string" }, owner: { type: "string" } } });
if (!values.fixtures || !values.alias || !values.project) {
  console.error("Usage: node scripts/deploy-viewer-preview.mjs --fixtures DIR --alias ALIAS --project SLUG [--owner ACCOUNT]");
  process.exit(2);
}
const listing = JSON.parse(await readFile(join(values.fixtures, "reports.json"), "utf8"));
const token = process.env.EXPLORE_PREVIEW_TOKEN?.trim() || undefined;
const result = await deployFixturePreview({
  reports: fixtureReports(listing, values.fixtures),
  project: values.project, alias: values.alias, ...(values.owner ? { owner: values.owner } : {}), ...(token ? { token } : {}),
});
console.log(JSON.stringify({ ...result, reports: listing }));
