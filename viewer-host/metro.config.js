// The preview Worker shares the agent API with the CLI's local report server: src/report/agent-api.ts and
// zip-reader.ts at the repository root. Metro only bundles files under its watch folders, and those files import
// each other with the `.js` extensions the CLI's NodeNext build needs, which name `.ts` sources here.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const shared = path.resolve(__dirname, "../src/report");
const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), shared];
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith("./") && moduleName.endsWith(".js") && context.originModulePath.startsWith(`${shared}${path.sep}`)) {
    return resolve(context, moduleName.slice(0, -".js".length), platform);
  }
  return resolve(context, moduleName, platform);
};
module.exports = config;
