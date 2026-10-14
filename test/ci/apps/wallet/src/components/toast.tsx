import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { entering, exiting } from '@/lib/motion';
import { colors, radius, space } from '@/theme';

type Toast = { id: number; message: string; tone: 'default' | 'success' | 'danger' };
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const show = useCallback((message: string, tone: Toast['tone'] = 'default') => {
    setToast({ id: Date.now(), message, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <View pointerEvents="none" style={[styles.host, { top: insets.top + 8 }]}>
          <Animated.View key={toast.id} entering={entering(FadeInUp.duration(220))} exiting={exiting(FadeOutUp.duration(180))} style={[styles.toast, tones[toast.tone]]}>
            <Text style={styles.text} accessibilityLiveRegion="polite">{toast.message}</Text>
          </Animated.View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

const tones = { default: { backgroundColor: colors.accent }, success: { backgroundColor: colors.success }, danger: { backgroundColor: colors.danger } };
const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 10 },
  toast: { maxWidth: '86%', paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill },
  text: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
});
