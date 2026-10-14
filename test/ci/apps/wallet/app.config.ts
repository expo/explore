import type { ExpoConfig } from 'expo/config';

const bundleIdentifier = 'com.expo-explore.example.wallet';

const config: ExpoConfig = {
  name: 'Wallet',
  slug: 'explore-example-app',
  owner: 'expo',
  version: '1.0.0',
  scheme: 'explore-example-wallet',
  orientation: 'portrait',
  // Only iOS has the dark palette (`hasDarkAppearance` in src/theme.ts); Android and web stay light.
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  extra: {
    eas: {
      projectId: 'f0e511e7-1636-463b-9f5f-5827c89cad03',
    },
  },
  ios: {
    bundleIdentifier,
    userInterfaceStyle: 'automatic',
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: 'com.expoexplore.example.wallet',
    adaptiveIcon: { foregroundImage: './assets/icon.png', backgroundColor: '#0F172A' },
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#0F172A',
        image: './assets/splash-icon.png',
        imageWidth: 160,
        resizeMode: 'contain',
        // The dark `brand` color (src/theme.ts) that the splash route continues; iOS only, like the palette.
        ios: { dark: { backgroundColor: '#0B0E14' } },
      },
    ],
    // Each permission is asked for only when a feature is first used, with these explanations.
    [
      'expo-location',
      {
        locationWhenInUsePermission: 'Wallet uses your location to show ATMs near you.',
        // Location is read only while Nearby ATMs is open.
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'Wallet uses the camera to scan QR codes when you pay someone.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    ['expo-contacts', { contactsPermission: 'Wallet shows your contacts so you can choose who to send money to.' }],
    'expo-notifications',
    // Required to launch on iOS 27 when built with Xcode 27; see the plugin.
    './plugins/scene-life-cycle',
  ],
};

export default config;
