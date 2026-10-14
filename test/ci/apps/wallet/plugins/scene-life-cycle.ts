import { type ConfigPlugin, withAppDelegate, withInfoPlist } from 'expo/config-plugins';

// iOS 27 refuses to launch an app built with the iOS 27 SDK (Xcode 27) unless it adopts the UIScene
// life cycle. The Expo SDK 57 template still starts React Native from the app delegate, so this moves
// it to the scene delegate that `expo` 57 already ships (`ExpoAppSceneDelegate`), as the SDK 58
// template does. Remove this plugin after upgrading to SDK 58.

const SCENE_DELEGATE = 'EXExpoAppSceneDelegate';
const PROVIDER = 'ExpoReactNativeFactoryProvider';
const CLASS_DECLARATION = 'class AppDelegate: ExpoAppDelegate {';
// The template creates the window and starts React Native here; the scene delegate does both instead.
const WINDOW_START = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n[\s\S]*?\n#endif\n/;

const withSceneLifeCycle: ConfigPlugin = config => {
  config = withInfoPlist(config, config => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE },
        ],
      },
    };
    return config;
  });
  return withAppDelegate(config, config => {
    const { language, contents } = config.modResults;
    if (language !== 'swift') throw new Error(`scene-life-cycle: expected a Swift AppDelegate, found ${language}`);
    if (contents.includes(`ExpoAppDelegate, ${PROVIDER}`)) return config;
    if (!contents.includes(CLASS_DECLARATION) || !WINDOW_START.test(contents)) {
      throw new Error('scene-life-cycle: the AppDelegate does not match the Expo SDK 57 template');
    }
    config.modResults.contents = contents
      .replace(CLASS_DECLARATION, `class AppDelegate: ExpoAppDelegate, ${PROVIDER} {`)
      .replace(WINDOW_START, '\n    // The scene delegate creates the window and starts React Native (UIScene life cycle).\n');
    return config;
  });
};

export default withSceneLifeCycle;
