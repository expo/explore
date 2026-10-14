import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { isExploreProfile } from '@/fixtures/runtime';

/** The version people see in About and quote to support (`version` in app.config.ts). */
export const appVersion = Constants.expoConfig?.version ?? '1.0.0';

/** Which kind of build this is: the explore profile for reviews, a development build, or a release. */
export const buildName = isExploreProfile ? 'Explore review' : __DEV__ ? 'Development' : 'Release';

/** The operating system and its version, such as iOS 26.0. */
export const systemName = `${Platform.OS === 'ios' ? 'iOS' : Platform.OS} ${Platform.Version}`;
