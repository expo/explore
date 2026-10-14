import { router } from 'expo-router';
import { Linking, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { usePermissions, type PermissionName, type PermissionState } from '@/lib/permissions';
import { colors, radius, space, text } from '@/theme';

/** Each permission, what Wallet uses it for, in the order Settings lists features. */
const ROWS: Array<{ name: PermissionName; title: string; icon: IconName; purpose: string }> = [
  { name: 'camera', title: 'Camera', icon: 'camera-outline', purpose: 'Scan a friend’s pay code in Send → Scan to pay.' },
  { name: 'location', title: 'Location', icon: 'location-outline', purpose: 'List partner ATMs near you, only while Nearby ATMs is open.' },
  { name: 'notifications', title: 'Notifications', icon: 'notifications-outline', purpose: 'Transaction alerts each time you send money.' },
  { name: 'contacts', title: 'Contacts', icon: 'people-outline', purpose: 'Pay someone from your iPhone contacts. Wallet reads their names only.' },
];

const STATUS: Record<PermissionState['status'], { label: string; color: ColorValue; background: ColorValue }> = {
  allowed: { label: 'Allowed', color: colors.success, background: colors.successSoft },
  denied: { label: 'Denied', color: colors.danger, background: colors.dangerSoft },
  'not-set': { label: 'Not set', color: colors.muted, background: colors.accentSoft },
};

/**
 * Settings → Privacy & permissions: what Wallet may use on this iPhone, read live from iOS. Allow asks for a
 * permission iOS has not been asked about; once it has answered, only iPhone Settings can change it, so the
 * row offers Open Settings. Nothing is asked for until a button is pressed.
 */
export default function PrivacyRoute() {
  const { states, request } = usePermissions();
  return (
    <Screen title="Privacy & permissions" subtitle="What Wallet can use on this iPhone. It asks only when you first use a feature that needs it."
      backFallback={() => router.replace('/settings')}>
      <View style={styles.group}>
        {ROWS.map((row, index) => (
          <PermissionRow key={row.name} {...row} state={states[row.name]} last={index === ROWS.length - 1} onAllow={() => request(row.name)} />
        ))}
      </View>
      <Text style={[text.caption, styles.note]}>
        Changes you make in iPhone Settings show here as soon as you’re back in Wallet. Your data stays on this iPhone.
      </Text>
    </Screen>
  );
}

function PermissionRow({ name, title, icon, purpose, state, last, onAllow }: {
  name: PermissionName; title: string; icon: IconName; purpose: string; state: PermissionState | undefined; last: boolean; onAllow: () => void;
}) {
  const status = state ? STATUS[state.status] : null;
  const detail = state?.limited ? `${purpose} Limited to the contacts you chose.` : purpose;
  return (
    <View style={[styles.row, !last && styles.divider]} testID={`privacy-${name}`}>
      <View style={styles.icon}><Icon name={icon} size={20} color={colors.ink} /></View>
      <View style={styles.body}>
        <View style={styles.heading} accessible accessibilityLabel={`${title}, ${status?.label ?? 'checking'}`}>
          <Text style={[text.body, styles.title]}>{title}</Text>
          {status ? (
            <Text style={[styles.status, { color: status.color, backgroundColor: status.background }]} testID={`privacy-${name}-status`}>{status.label}</Text>
          ) : null}
        </View>
        <Text style={text.caption}>{detail}</Text>
        {/* Each of the four buttons names its permission for VoiceOver, since the heading is a separate element. */}
        {state ? (
          state.canAsk
            ? <Button label="Allow" accessibilityLabel={`Allow ${title}`} variant="secondary" compact onPress={onAllow}
                testID={`privacy-${name}-allow`} style={styles.action} />
            : <Button label="Open Settings" accessibilityLabel={`Open Settings for ${title}`} variant="secondary" compact
                onPress={() => { Linking.openSettings(); }} testID={`privacy-${name}-settings`} style={styles.action} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.lg },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  icon: { width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: space.xs },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: space.sm, rowGap: space.xs },
  title: { fontWeight: '600' },
  status: { fontSize: 12, fontWeight: '700', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' },
  action: { alignSelf: 'flex-start', marginTop: space.sm },
  note: { textAlign: 'center', paddingHorizontal: space.sm },
});
