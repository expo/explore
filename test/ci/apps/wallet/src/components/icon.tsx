import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

export type IconName = keyof typeof Ionicons.glyphMap;

/** A decorative glyph. Screens label the surrounding control, so the glyph stays out of accessibility. */
export function Icon(props: ComponentProps<typeof Ionicons>) {
  return <Ionicons {...props} accessible={false} accessibilityElementsHidden importantForAccessibility="no" />;
}
