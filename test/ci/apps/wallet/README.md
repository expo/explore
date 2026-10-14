# Wallet — Expo Explore example app

A small, backend-free wallet app used as the input of the local Explore CI tests
(`test/ci`). Every success, failure, loading, modal and popup state is implemented on
the device, so a CI run can reach all of them without a server, a payment provider
or a real account. Nothing leaves the simulator.

It is an example input only: the CI flow and its checks contain nothing specific to it.

## Screens

| Area | Routes | Opened from |
| --- | --- | --- |
| Splash | `/` (animated logo; `?hold=true` keeps it on screen) | launch |
| Onboarding | `/onboarding`, `/onboarding/features`, `/onboarding/currency` | splash, before onboarding is finished |
| Auth | `/auth/sign-up`, `/auth/sign-in` (signed-out only; a signed-in visit goes to Home) | onboarding, sign out |
| Tabs | `/home`, `/activity`, `/cards`, `/settings` (a native tab bar: Liquid Glass on iOS 26) | sign-in |
| Cards | `/cards/[id]` (for example `card-1`): the card large, with Freeze, Details and Limits in a bottom toolbar | Cards |
| Send money | `/send` → `/send/amount?to=` (or `?name=`) → `/send/review?to=&amount=` → `/send/processing` → `/send/success?tx=` or `/send/failed?reason=` | Home → Send |
| Scan to pay | `/send/scan`: the camera reads a Wallet pay code and opens `/send/amount` | Send → Scan to pay |
| Pay a contact | `/send/contacts`: the iPhone's contacts; one opens `/send/amount?name=` | Send → From contacts |
| Activity | `/activity` (a search field filters by name, reference or amount), `/transactions/[id]` (for example `tx-0011`), with Share receipt, Split and Report a problem in a bottom toolbar | Activity, Home's Recent activity, a transaction alert |
| Nearby ATMs | `/atms`: partner ATMs in the nearest city, by distance | Home → ATMs |
| Modals | `/topup` (inline loading, success and failure), `/paywall` | Home |
| Plan | `/subscription` (billing cycle, Cancel Premium sheet) | Settings → Subscription |
| Account | `/account` (display name, sign out), `/account/delete` | Settings → the account row |
| Notifications | `/notifications`: Transaction alerts, with a preview | Settings → Notifications |
| Appearance | `/appearance`: System, Light or Dark, and whether Increase Contrast is on | Settings → Appearance |
| Privacy | `/privacy`: camera, location, notifications and contacts, live | Settings → Privacy & permissions, About |
| About | `/about`, `/about/diagnostics` (version, memory and accessibility, live) | Settings → About Wallet |

Everything below the tabs requires a session and redirects to `/auth/sign-in` without one.
Amounts in links are minor units: `amount=2500` is 25.00. A Send link names its recipient with
`to=` (a Wallet id such as `alex`) or, for someone from the iPhone's contacts, `name=`.

## iPhone settings Wallet follows

Each feature below follows a setting of the iPhone without a relaunch: the display and accessibility
settings while a screen is open (Reduce Motion's entrance animations from the next screen or sheet
that opens), and a permission as soon as Wallet is active again (iOS ends the app for some permission
changes).

| iPhone setting | What Wallet does | Where to look |
| --- | --- | --- |
| Light or Dark appearance | every color switches; Settings → Appearance can keep Wallet Light or Dark instead | every screen, `/appearance`, `/about/diagnostics` |
| Increase Contrast | stronger text, lines and edges, in both appearances | every screen, `/appearance`, `/about/diagnostics` |
| Reduce Transparency | the glass controls over a card's art turn solid; iOS turns its tab bar and toolbars solid | `/cards/[id]`, the tabs, `/transactions/[id]`, `/about/diagnostics` |
| Liquid Glass (Clear or Tinted, iOS 26.1 and later) | the tab bar and bottom toolbars are iOS's own glass bars, so they take the chosen look | the tabs, `/cards/[id]`, `/transactions/[id]` |
| Reduce Motion | no entrance animations, no balance count-up, a full splash mark at once, glass controls that ignore touch | `/`, `/home`, sheets, results, `/cards/[id]`, `/about/diagnostics` |
| Text Size, up to the largest accessibility size | every screen grows; at the accessibility sizes rows stack and pinned buttons join the scrolling content | every screen, `/about/diagnostics` |
| VoiceOver | controls carry labels, roles and states for it; it reads Scan to pay's messages about a code and, once typing pauses, how many transactions a search matches; Diagnostics shows whether it is on | every screen, `/send/scan`, `/activity`, `/about/diagnostics` |
| Window width (iPhone Duo folded or open) | on a wide window, content keeps a readable width, centred | every screen, `/about/diagnostics` (window size) |
| Memory warning | gives back cached card art and insights, and records the warning | `/about/diagnostics` |
| Location | lists the partner ATMs of the nearest city and follows the location | `/atms` |
| Location permission | Use my location; Open Settings once refused | `/atms`, `/privacy` |
| Camera permission | Scan a code; Open Settings once refused | `/send/scan`, `/privacy` |
| Contacts permission (full or limited) | From contacts and the contact list; Choose more contacts when limited | `/send`, `/send/contacts`, `/privacy` |
| Notifications permission | Transaction alerts, and the Notifications row in Settings | `/notifications`, `/settings`, `/privacy` |

A permission is asked for only when its button is pressed, never when a screen opens. The sections below
describe each feature.

The notifications permission is the exception on a simulator. iOS keeps each app's notification
setting in SpringBoard, which reads the saved settings only when it starts, so a tool that edits the
saved file changes nothing until SpringBoard restarts. To see such a change, restart SpringBoard,
which also ends Wallet (`xcrun simctl spawn <udid> launchctl stop com.apple.SpringBoard`), or reboot
the simulator, then open Wallet: Allowed, Denied, or Not set with Allow after a reset. iPhone
Settings → Apps → Wallet → Notifications changes the permission at once instead. Checked on iOS 26.5.

## Appearance

The app follows the iPhone's Light or Dark appearance and Increase Contrast
(Settings → Accessibility → Display & Text Size), and switches while it is open. Every color is a
token in `src/theme.ts` with four values (light, dark, and each with increased contrast); on iOS a
token is a `DynamicColorIOS`, so the native views resolve it and no screen re-renders for a change.
The splash and the welcome screen keep their dark brand background, with a light status bar, in
both appearances.

Settings → Appearance chooses System (the default), Light or Dark for the whole device: it is kept
through sign-out and account deletion, and state saved before the setting existed loads as System.
Light and Dark override the iPhone's setting with `Appearance.setColorScheme`; System hands the
choice back to iOS. The screen also shows, live, whether Increase Contrast is on.

Only iOS has the dark values (`hasDarkAppearance` in `src/theme.ts`). On Android the app is light
only: `userInterfaceStyle` is `light` there (`automatic` on iOS), the status bar keeps dark content,
the splash screen has no dark variant, and Settings has no Appearance row.

On iOS 26 the tab bar, the bottom toolbars and the round controls over a card's art are Liquid
Glass. With Reduce Transparency on (Settings → Accessibility → Display & Text Size), the system
bars turn solid by themselves and the controls over the card art become solid buttons in the app's
colors; they switch back when it is turned off, while the screen is open.

With Reduce Motion on (Settings → Accessibility → Motion), screens and sheets appear without their
entrance animations, the balance shows its value instead of counting up, the splash mark is full at
once, and the glass controls stop responding to touch (`src/lib/motion.ts`). The app follows the
setting while it is open: a screen opened after the change uses it.

Every screen follows the iPhone's text size (Settings → Display & Brightness → Text Size, and
Larger Accessibility Sizes) up to the largest accessibility size, also when it changes while the
screen is open. At the accessibility sizes, rows put their value or switch under the label, amounts in
lists go under the names, Home's actions go two by two, side margins narrow, and a screen's pinned
buttons move to the end of its content, which then scrolls; sheets scroll too. Titles grow to twice
their size and large amounts to one and a half times, on one line; the glyphs inside fixed shapes
(initials, the keypad, the card art) barely grow, and body text grows all the way.

On a wide screen, such as an unfolded iPhone Duo, pages, sheets, the scanner and the transfer screens
keep their content at a readable width of at most 600 pt, centred, with the background running to the
edges, and a card stays at most 440 pt wide (`layout` in `src/theme.ts`). The app stays portrait.

## About and diagnostics

Settings → About Wallet (`/about`) shows the version from `app.config.ts` and leads to Diagnostics
(`/about/diagnostics`), the details a bank's support asks for, each following the iPhone while the
screen is open:

- **App**: version, build (Review for the explore profile, Development or Release), iOS version and
  the window size in points (it changes when an iPhone Duo folds or unfolds).
- **Memory**: the last memory warning iOS sent (kept across launches) and how many arrived since the
  app opened. On a warning (`AppState` `memoryWarning`) the app
  gives back its in-memory caches, each card's art and the spending insight behind Activity's
  "spent in the last 30 days", and rebuilds them when a screen next needs them (`src/lib/memory.ts`).
- **Display and accessibility**: the appearance and whether it follows the iPhone, the text size (its
  percentage and its name in iPhone Settings, from `fontScale`), and Reduce Motion, Reduce
  Transparency, Increase Contrast and VoiceOver, read from `AccessibilityInfo` with their change events.

Share diagnostics sends all of it, with what each cache holds, through the iOS share sheet. Cache
contents stay off the screen, since they depend on the screens visited before.

Each card has its own art: the first is lit violet and blue, and every further card gets another
pair of lights.

## Location, camera, contacts and notifications

Each feature asks for its permission only when the user presses its button, never when a screen
opens, and shows what to do when access is off (Open Settings). A screen reads the permission again
each time the app becomes active, so a change made in iPhone Settings shows as soon as the app is
back (see [iPhone settings Wallet follows](#iphone-settings-wallet-follows) for notifications).

- **Nearby ATMs** (Home → ATMs, `/atms`). Before anything is pressed it explains why it wants the
  location. Use my location asks for When In Use access, then lists the partner ATMs of the nearest
  of fourteen cities, nearest first, with the distance and walking time; tapping one opens walking
  directions in Maps. The cities are Xcode's location presets: Berlin, Cupertino,
  Hong Kong, Johannesburg, London, Mexico City, Mumbai, New York, Paris, Rio de Janeiro, San
  Francisco, Sydney, Tokyo and Warsaw (`src/fixtures/atms.ts`). The list follows the location while
  the screen is open, so choosing another preset moves it to that city; more than 50 km from every
  partner ATM, it says so and shows the closest city. Once allowed, the screen locates at once on
  later visits.
- **Scan to pay** (Send → Scan to pay, `/send/scan`). Scan a code asks for the camera, then scans QR
  codes. A Wallet pay code, `wallet://pay?to=alex` (a Wallet id, or a handle such as `@alexr`),
  replaces the scanner with the amount keypad for that recipient, so Back returns to Send. A pay
  code for someone not on Wallet, or any other code, shows a short message and scanning carries
  on. The torch button lights dark codes. Once allowed, the camera starts at once on later visits.
- **Pay a contact** (Send → From contacts, `/send/contacts`). From contacts asks for access to the
  contacts, then opens a searchable list of the iPhone's contacts; Wallet reads their names only.
  Picking one opens the amount keypad for them: the Send links name such a recipient with
  `name=Kate Bell` instead of `to=`, and the transfer follows the same rules and fee. A contact with
  the same name as someone on Wallet is marked On Wallet and paid as them. With iOS 18 limited access
  the list shows the shared contacts and offers Choose more contacts. If access was refused before,
  From contacts offers Open Settings; `/send/contacts` opened directly asks only when Allow access is
  pressed. The list follows changes to the contacts.
- **Transaction alerts** (Settings → Notifications, `/notifications`). Turning Transaction alerts on
  asks iOS to allow notifications; when a transfer then completes, Wallet posts "You sent $25.00 to
  Alex Rivera." (what the recipient gets, like Money sent), as a banner even while the app is open.
  Tapping the alert opens that transfer's receipt, also when it launches the app: the alert carries
  the receipt's link (`explore-example-wallet:///transactions/tx-0013`), and the app opens it as an
  incoming link, not with a router call. The root layout handles the tap, so to Explore's source
  analysis a router call there would be a link from every screen to the receipt, and a change to the
  receipt would capture every screen. The switch keeps
  the wallet's notifications setting: it shows on only while that setting is on and iOS allows
  Wallet's notifications, and Settings shows the same On or Off. A new account's setting starts on,
  so alerts begin once iOS allows them. When iOS has them off, the screen says so and links to
  Settings.
- **Privacy & permissions** (Settings → Privacy & permissions, `/privacy`). One row for each of the
  four, with what Wallet uses it for and iOS's current answer: Allowed, Denied or Not set. The answers
  are read (never requested) each time the screen gains focus and each time the app becomes active, so
  a grant, revoke or reset from iPhone Settings shows as soon as Wallet is back. A permission iOS has not asked
  about offers Allow, which shows iOS's prompt; once iOS has an answer, the row offers Open Settings,
  the only place it can change. VoiceOver reads each button with its permission, such as Allow
  Camera or Open Settings for Camera. Allowing notifications here also turns Settings → Notifications
  on, since a new account's setting starts on.

## Test account

No account exists until one is created through Sign up. Use the synthetic values
`Review User`, `reviewer@example.test`, `WalletReview123!`. They exist only in the
simulator's app sandbox and grant no access anywhere else. Sign out keeps the account;
Delete account removes it and its wallet. Registering the same email twice reports that
the account exists.

A new account starts on the Free plan with a balance of $1,250.00, one virtual card
(`card-1`, •••• 4242, no monthly limit) and twelve past transactions (`tx-0001` … `tx-0012`); new transactions
continue from `tx-0013`.

## Client-side outcomes

| Action | Rule | Result |
| --- | --- | --- |
| Sign in | unknown email or wrong password | "Incorrect email or password." under the form |
| Sign up | invalid email, password under 8 characters, existing email | inline error |
| Send | recipient Dana Declined (the Wallet contact) | `/send/failed?reason=declined` |
| Send | amount + fee above the balance | `/send/failed?reason=insufficient` (offers Top up) |
| Send | anything else | `/send/processing` for 1.2 s, then `/send/success` |
| Top up | exactly 13.00 | "Card declined" inside the modal |
| Top up | any other amount | loading, then "Top up complete" |
| Paywall | Subscribe | 0.8 s loading, then "Welcome to Premium" |
| Paywall | Restore purchases | "No previous purchases to restore." |
| Cancel Premium | confirm in the sheet | back to Free; cards beyond the first are frozen |
| Freeze card | switch on in Cards, or Freeze in the card's toolbar; confirm in the sheet | card shows Frozen; Unfreeze undoes it at once |
| Card details | Details in the card's toolbar | a sheet with the number (`4000 0000 0000` and the last four), expiry, a security code derived from the last four, and the name |
| Show card number | the eye over the card art | the full number on the card until the eye is pressed again or the screen closes |
| Monthly limit | Limits in the card's toolbar, or the Monthly limit row | No limit, $250, $500, $1,000 or $2,500, kept per card |
| Share receipt | a transaction's toolbar | the iOS share sheet with the receipt as text |
| Split | a payment's toolbar (off for money in); choose contacts | an equal share of the amount without the fee, you included; "Requested … from …" (nothing is sent) |
| Report a problem | a transaction's toolbar; pick a reason | "Thanks — we’ll look into it" |
| Sign out | Settings or Account, then Yes, sign out in the alert | sign-in screen |
| Delete account | type DELETE, press Delete account, then Yes, delete in the alert | 1.2 s loading, then sign-in; the account is gone |

Free vs Premium: Free transfers cost 1% (at least $0.10) and allow one card, and Home shows
a Go Premium banner; Add virtual card opens the paywall. Premium ($4.99 a month or $39.99 a
year) has no transfer fee and up to five cards. ATM cash is free up to $200 a month on Free and
$800 on Premium, then 2% (shown on Nearby ATMs; no withdrawal happens in the app).

## Known flows

Back and Close go to the previous screen. A screen opened by a cold deep link has no previous
screen, so they replace it with a fixed parent instead:

| Screen | Back or Close without history |
| --- | --- |
| `/onboarding/features`, `/onboarding/currency` | `/onboarding` |
| `/auth/sign-up` | `/auth/sign-in` |
| `/account`, `/subscription`, `/appearance`, `/notifications`, `/privacy`, `/about` | `/settings` |
| `/about/diagnostics` | `/about` |
| `/atms` | `/home` |
| `/send/scan`, `/send/contacts` | `/send` |
| `/account/delete` | `/account` |
| `/transactions/[id]` | `/activity` |
| `/cards/[id]` | `/cards` |
| `/send` | `/home` |
| `/send/amount`, `/send/review` | `/send` |
| `/topup`, `/paywall` | `/home` |

Each screen passes that parent as a literal router call, not as an href prop:
`backFallback={() => router.replace('/settings')}` on `Screen`, and
`goBack(() => router.replace('/home'))` (`src/lib/navigation.ts`) in the modals. Explore's
source analysis then resolves every destination; an href handed through a prop is a runtime
value to it, and an unresolved destination makes it capture every screen.

- Continue on Pick your currency pushes sign-up, so Back on sign-up returns to it. Create an
  account on sign-in also pushes sign-up; I already have an account returns to the sign-in
  beneath it, or replaces sign-up when there is none.
- Signing in or up leaves Home as the only screen in the root stack: before it redirects, the
  auth layout (`src/app/auth/_layout.tsx`) drops whatever is beneath the auth forms, such as
  onboarding. Sign out and Delete account then leave sign-in alone, with nothing to swipe back to.
- The splash moves on each time it is focused: to Home with a session (also when onboarding was
  skipped through I already have an account), otherwise to onboarding until it is finished,
  otherwise to sign-in. A deep link opened during launch covers the splash; Back to it moves on
  again.
- Try another recipient on a declined transfer returns to the recipient list beneath it.
- Manage subscription (the paywall on Premium) closes the paywall, then opens Subscription in
  the signed-in stack.

## `explore` build profile

`eas build --profile explore --platform ios` sets `EXPO_PUBLIC_EXPLORE_MODE=true`
(`src/fixtures/runtime.ts`). The profile changes only what a screenshot comparison needs:

- The clock is fixed at 1 September 2026, 10:00 UTC, so dates, "Today", receipts and
  renewal dates are the same on every run. Dates are always shown in UTC.
- Entrance animations and the balance count-up render their final frame, loading
  indicators are static dots, and the glass controls over card art do not react to touch, so a
  capture never lands mid-animation.
- Nearby ATMs stays on its explainer until Use my location is pressed, and Scan to pay until Scan a
  code is pressed, even when location or camera access was already allowed.
- `?hold=true` keeps the two transient screens on display: `/` (splash) and
  `/send/processing`.

Accounts, balances, rules and navigation behave exactly as in any other build. The profile is a
Release build.

The wallet scenarios (`test/ci/scenarios/wallet`) never grant a permission or change the appearance,
so the permission screens are captured in their unasked state, with Settings → Appearance on System.

## Accessibility identifiers

`onboarding-start`, `features-continue`, `currency-continue`, `auth-name`, `auth-email`,
`auth-password`, `auth-submit`, `home-balance`, `home-upsell`, `activity-search`, `activity-results`, `send-search`,
`send-amount-continue`, `send-confirm`, `send-processing`, `send-done`, `failed-retry`,
`failed-top-up`, `topup-amount`, `topup-submit`, `topup-done`, `topup-retry`,
`paywall-subscribe`, `paywall-restore`, `paywall-done`, `subscription-cancel`,
`subscription-upgrade`, `cancel-confirm`, `cards-add`, `freeze-confirm`, `card-number-toggle`,
`card-limit`, `card-details-done`, `split-request`, `settings-account`, `settings-subscription`, `settings-appearance`, `settings-notifications`,
`settings-privacy`, `settings-about`, `settings-sign-out`, `about-diagnostics`, `about-privacy`, `appearance-system`, `appearance-light`, `appearance-dark`,
`appearance-contrast`, `account-session`, `account-name`, `account-save`,
`account-sign-out`, `account-delete`, `delete-account-input`, `delete-account-confirm`,
`atms-locate`, `atms-settings`, `send-scan`, `scan-start`, `scan-settings`, `send-contacts`,
`contacts-allow`, `contacts-settings`, `contacts-search`, `contacts-choose`,
`notifications-transactions`, `notifications-settings`, and on Privacy & permissions
`privacy-<name>`, `privacy-<name>-status`, `privacy-<name>-allow` and `privacy-<name>-settings` for
`camera`, `location`, `notifications` and `contacts`. Diagnostics rows are `diagnostics-version`,
`diagnostics-build`, `diagnostics-system`, `diagnostics-screen`, `diagnostics-memory-warning`,
`diagnostics-appearance`, `diagnostics-text-size`, `diagnostics-reduce-motion`,
`diagnostics-reduce-transparency`, `diagnostics-increase-contrast` and `diagnostics-voiceover`, with
`diagnostics-share` for Share diagnostics. The states of the permission screens are
`atms-explainer`, `atms-searching`, `atms-list`, `atms-denied` and `atms-services-off` on Nearby ATMs,
`contacts-explainer`, `contacts-denied` and `contacts-list` on Your contacts, and `scan-notice` for
Scan to pay's message about a code.

The amount keypad keys are buttons labelled `0`–`9`, `Decimal point` and `Delete`. Buttons in a
native bottom toolbar carry no identifier; select them by label: Freeze (Unfreeze on a frozen
card), Details and Limits on a card, and Share receipt, Split and Report a problem on a transaction.

## Simulator notes

- Alert buttons have labels no other control on the screen uses (Yes, sign out; Yes, delete),
  because native alert buttons carry no accessibility identifier.
- iOS asks "Save Password?" after sign-up or sign-in; choose Not Now. The sheet is a system
  surface whose accessibility tree has Not Now both as a cell and as a button, so select the
  button (`role=button label="Not Now"`). The auth fields opt out of password AutoFill, so no
  strong-password sheet appears.
- Opening a link from outside the app shows iOS's "Open in “Wallet”?" confirmation.
- Location, camera, contacts and notification prompts are system alerts too. `xcrun simctl
  privacy` grants, revokes or resets location and contacts without a prompt. iOS ends the app for
  some of these changes; otherwise the app shows the change when it is next active.

## Local checks

```sh
npm ci
npm run typecheck
npx expo run:ios   # EXPO_PUBLIC_EXPLORE_MODE=true npx expo start for the explore profile
```

The EAS project is `@expo/explore-example-app`. Generated `ios/` and `android/` folders
are ignored; `npm run prebuild` regenerates `ios/` after a native dependency changes.

iOS 27 does not launch an app built with Xcode 27 unless it uses the UIScene life cycle, which
the Expo SDK 57 template does not. `plugins/scene-life-cycle.ts` moves the app to `expo`'s
`ExpoAppSceneDelegate`, as the SDK 58 template does; an `ios/` folder generated before the plugin
needs `npm run prebuild`. Remove the plugin after upgrading to SDK 58.
