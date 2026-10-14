import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Minimal installed-package shape for capture orchestration tests; no SDK execution. */
export async function writeCaptureObserverPackages(project, { provider = 'expo-router', expoVersion = '57.0.18' } = {}) {
  const files = {
    'node_modules/expo/package.json': JSON.stringify({ name: 'expo', version: expoVersion }),
    'node_modules/@expo/cli/package.json': JSON.stringify({ name: '@expo/cli', version: '57.0.20' }),
    'node_modules/@expo/cli/build/src/start/server/metro/instantiateMetro.js': '// overrideConfigPath: _env.env.EXPO_OVERRIDE_METRO_CONFIG',
    ...(provider === 'expo-router' ? {
      'node_modules/expo-router/package.json': JSON.stringify({ name: 'expo-router', version: '57.0.17' }),
      'node_modules/expo-router/build/react-navigation/core/SceneView.js': 'exports.SceneView = function Scene() {};',
      'node_modules/expo-router/build/react-navigation/core/NavigationContainerRefContext.js': 'exports.NavigationContainerRefContext = {};',
    } : {
      'node_modules/@react-navigation/core/package.json': JSON.stringify({ name: '@react-navigation/core', version: '7.13.0' }),
      'node_modules/@react-navigation/core/lib/module/SceneView.js': 'exports.SceneView = function Scene() {};',
      'node_modules/@react-navigation/core/lib/module/NavigationContainerRefContext.js': 'exports.NavigationContainerRefContext = {};',
    }),
  };
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(project, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}
