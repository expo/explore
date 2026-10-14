// Two exports share this app and the staged Viewer under public/viewer:
// - default: the central report page (explore-preview.expo.app), routes in src/app
// - EXPLORE_HOST_VARIANT=preview: one deployment per review, routes in src/app-preview;
//   deployed by `expo-explore ci:deploy` into the reviewed app's own EAS project.
const preview = process.env.EXPLORE_HOST_VARIANT === "preview";

export default {
  expo: {
    name: preview ? "Expo Explore preview" : "Expo Explore Viewer",
    slug: preview ? "explore-preview" : "explore-viewer",
    ...(preview ? {} : { owner: "expo-public" }),
    version: "0.1.0",
    orientation: "default",
    web: { bundler: "metro", output: "server" },
    plugins: ["expo-router"],
    extra: {
      router: { root: preview ? "./src/app-preview" : "./src/app" },
      ...(preview ? {} : { eas: { projectId: "e873172f-ae54-4291-9a50-3d09d5435b12" } }),
    },
  },
};
