# Capture base and head under the same conditions

Status: Not started. Line references are to `4ed584c9` (Release 0.20.7).

A review compares a route's base frame with its head frame and reports the
difference as the PR's change. That only holds when both frames were captured
from the same app state and the same keyboard. Today neither is guaranteed,
and a screen the PR did not touch can lead the comment with a large change.

## What we saw

In euxy#176's 0.20.7 review (iPhone, runs 39521260432 head and 39521251171
baseline), two rows were wrong:

1. **App state.** Dark `/rename-pattern` showed "Untitled" on base and
   "Lo-Fi Bounce" on head. The row led with "Added button 'Pattern Lo-Fi
   Bounce — menu'".
2. **Keyboard.** The software keyboard was drawn in some captures of the
   autofocused rename sheet and not others, a 46–48% visual mismatch.
   `keyboard.jsonl` said `shown` for every frame, drawn or not.

## Why

**App data carries from one appearance pass to the next.** Head ran light
routes 1–16 and then dark routes 1–16 in one session. The light pass's `/p`
import (routes 10–11) appends a pattern and makes it active, persisted in
sqlite:

```ts
// euxy src/state/store.ts
patterns: [...s.patterns, pattern],
activePatternId: pattern.id,
```

euxy captures with `launch: video`, so the dark pass relaunches through
`captureLaunch` ([`run.ts:1030`](../src/capture/run.ts)), which keeps app data
on purpose. Launch errors there are caught and logged, and routes are captured
anyway. The plain relaunch at [`run.ts:1041`](../src/capture/run.ts) only runs
when launch observation is off. The baseline split light and dark into fresh
sessions, so its dark pass started clean. Session layout is excluded from the
capture recipe on the grounds that it does not change the evidence
([`artifact-cache.ts:34`](../src/ci/artifact-cache.ts)), which is not true
today.

**Partial baseline reuse changes the order.** When only some routes are cached,
the base side captures just the rest
([`run.ts:357`](../src/capture/run.ts)):

```ts
const missingRoutes = routes.filter(route => !cachedImages[route.id]);
```

Those frames see a different history within the pass from head's.

**"Shown" is only the accessibility tree's word.** `keyboardSettle`
([`keyboard.ts`](../src/capture/keyboard.ts)) reports `shown` after two
matching tree reads, including frames with no keyboard drawn.
`keyboard.jsonl` is not in the exported diagnostics
([`run.ts:384`](../src/capture/run.ts)).

**A caveat cannot win the row.** `decideReview`
([`evidence-assessment.ts:471`](../src/review/evidence-assessment.ts)) makes
any difference `modified` and uses the first fact as the description:

```ts
const differs = visual.verdict === "modified" || changes.length > 0;
```

Review issues are appended only when there are no facts. Added and removed
elements rank ahead of text changes (priority 20 vs 30,
[`evidence-comparator.ts:143`](../src/review/evidence-comparator.ts)). With the
keyboard up, euxy's raised sheet covers Hat, Clap and Bass, so those become the
leading "Added/Removed button" facts.

**Reinstalling is not a clean slate.** Argent's `reinstall-app`
([`argent-driver.ts:712`](../src/capture/argent-driver.ts)) uninstalls and
installs, but ignores uninstall errors. iOS keychain and SecureStore data
survive an uninstall. EAS `simulator:control` has no clear-data, keychain or
keyboard action.

## Goal

For each route, base and head frames in the same appearance come from the same
app history and an equally verified keyboard state, whatever the session layout
and including reused baselines. Where the conditions still differ, the row says
so instead of reporting a PR change. Real text changes are still reported.

Done means:

- Rerun euxy#176 against a fresh baseline. Dark `/rename-pattern` and
  `/patterns` show the same pattern on both sides.
- Each keyboard screen either draws the keyboard on both sides, or reads
  "Added text 'Pattern name' · keyboard shown on one side only". It no longer
  leads with a 46% visual change or with buttons the sheet covers.
- An unchanged screen with an autofocused field is never a PR change.

## Plan

### Phase 0: probes and diagnostics

These results decide whether phase 2 goes ahead and which reset each backend
uses.

1. **Fuller keyboard log.** Add the scheme, the pass, the tree's keyboard
   bounds, Argent's `keyboardVisible`, the screen size and the app's keyboard
   metrics to `keyboard.jsonl`, and export it.
2. **App-side keyboard probe on EAS**, with Argent and with agent-device. Read
   `Keyboard.metrics()` and the show and hide events, and work out how much of
   the window the keyboard covers. Compare that with a screenshot, a tree read,
   and a second screenshot about 2 s later. Capture at least one session where
   the keyboard is not drawn. The question is whether any signal separates
   drawn from not drawn, and whether a missing keyboard is a late draw or a
   suppressed one.
3. **Reset probe.** Write a test value into app storage through a fixture
   app's deep link, reinstall through each controller on EAS and locally, and
   check that it is gone. Check the keychain too, and time each reset.

### Phase 1: identical app history

4. **`resetAppData` per backend**, using what phase 0 verified:
   - Argent: `reinstall-app`, checked with the test value.
   - agent-device: uninstall, then install.
   - Local iOS: `simctl uninstall` and `install`, plus
     `simctl keychain <udid> reset`.
   - Local Android: `pm clear`.

   Reuse the built `localApp`. Any other backend reports `unsupported`.
5. **Reset at the start of every later captured pass** (`capturePass` in
   `run.ts`):
   - Run it before appearance and launch observation, so it covers
     `launch: video` and `launch: off` alike.
   - Count the passes captured in this session, not the loop index. A
     dark-only split session starts at index 1.
   - A failed reset escapes into the per-pass `try` and lands in
     `sessionFailures`, not in the launch catch.
   - Clear `deepLinkPromptAccepted` in the bridge's install case and approve
     URL schemes again.
6. **Fall back to separate sessions.** When no verified reset exists, or the
   app keeps state in the keychain on EAS, run each appearance in its own
   session ([`session-plan.ts`](../src/ci/session-plan.ts)).
7. **Same history on both sides.**
   - Reuse a baseline pass only if every selected route in it is cached;
     otherwise capture the whole pass.
   - Capture routes that exist on only one side last in that side's pass.
   - Record `passStart: "fresh" | "continued"` and `reused` on each image
     entry.
8. **Cache recipe.** Add `passStart` to `captureRecipeConfig`, so a capture
   without the reset is never reused against one with it, even without a
   version bump. Reword the `maxSessions` comment.

### Phase 2: keyboard state and an honest row

Only if phase 0 finds a signal that separates a drawn keyboard from an
undrawn one.

9. **Keyboard signal from the app.** The observer
   ([`observer.ts`](../src/capture/observer.ts)) reads `Keyboard.metrics()`
   when it mounts, then listens for show and hide. Add the key to the
   `parseCaptureDestination` allowlist so it never becomes a text node.
10. **Three-state wait:**
    - `shown` when the tree and the app agree;
    - `suppressed` after two reads with the tree stable and the app reporting
      no coverage, without waiting out the 4 s cap;
    - `unknown` when the app gives no signal.
11. **Tie the state to the screenshot.** Read it just before and just after
    the screenshot ([`route-capture.ts`](../src/capture/route-capture.ts)). If
    it changed, retake once, or record `unstable`. Store it on
    `images[id].keyboard` so it survives the scheme merge, `export-merge`,
    restore and the schema.
12. **Review rule** (`evidence-assessment.ts`, after the facts are computed).
    It applies when the two sides' states differ, or when either is `unknown`
    or `unstable` on a screen with a focused text field. Then:
    - mark the visual verdict not comparable;
    - drop added or removed elements that sit where the other side's raised
      sheet or keyboard would cover them;
    - keep paired text edits, and text inside the focused container;
    - if text facts remain, the row is `modified` with the keyboard caveat
      appended to the description after `decideReview`;
    - otherwise a `scope === "none"` screen stays a variant, and anything else
      is `needs-review` with the caveat;
    - show the caveat in the PR comment and the Viewer.
13. **Keep the keyboard on screen where possible.** Local Android:
    `settings put secure show_ime_with_hard_keyboard 1`. EAS: a serve-sim
    action, if one is added. Local iOS boots headless, so phase 0 confirms
    whether the Simulator.app preference applies.

### Rejected

- Dismissing the keyboard: Return submits euxy's sheet.
- Masking the keyboard band: the sheet shift is most of the mismatch.
- Detecting the keyboard from pixels: brittle across keyboards and themes.
- A fresh context for every route: cost, and
  [`route-reset.ts`](../src/capture/route-reset.ts) records the settle
  failures that led away from it.
- Replaying the other side's history: fragile; whole-pass reuse covers the
  case.

## Risks

- **Cost:** about 25 s of reset per extra pass, measured in phase 0.
  Whole-pass reuse costs more only when a pass is partly cached.
- **No usable keyboard signal:** phase 2 ships only the "keyboard couldn't be
  verified" path.
- **A real change hidden behind the sheet gets dropped:** the visual verdict is
  already not comparable there, and the caveat flags the screen for a person.
- **New fields lost in merge or restore:** one test runs them through every
  step.

## Tests

- **`ci-map`:** reset before later passes with `launch: video` and
  `launch: off`; no reset for a dark-only first pass; a failed reset lands in
  `sessionFailures`; the session split when no reset exists; whole-pass reuse;
  one-side-only routes last.
- **`keyboard`:** each state, Android `keyboardVisible`, and an `unstable`
  change around the screenshot.
- **Observer:** the keyboard key never becomes a text node.
- **Merge, cache and schema:** `images[id].keyboard` and `passStart` survive.
- **Assessment, on the real rename trees from the runs above:** covered Hat,
  Clap and Bass are dropped; "Pattern name" carries the caveat; an unchanged
  autofocus screen is not a PR change; the comment row wording.
- **Local end to end:** force no keyboard on Android
  (`show_ime_with_hard_keyboard 0` with a hardware keyboard) and check the
  recorded state and the row.
- **Real run:** a fresh euxy baseline, then #176. Check the reset log and
  timing, dark rename and `/patterns`, `keyboard.jsonl`, and the row wording.

## Open questions

1. Can serve-sim add clear-app-data, keychain-reset and hardware-keyboard
   actions to EAS sessions? Without them, EAS relies on Argent's reinstall and
   on separate sessions for apps that keep state in the keychain.
2. Is about 25 s per extra appearance pass acceptable by default, or should
   the reset be a setting?
3. If phase 0 finds no signal that separates a drawn keyboard from an undrawn
   one, is labelling every focused-field screen with a differing or unverified
   keyboard as "keyboard couldn't be verified" acceptable?

## How this plan was made

Codex `gpt-6-astra`, Grok `grok-4.7` and Claude each wrote a plan
independently. Each plan was reviewed by a different model, merged, and the
merged plan reviewed again by all three, at high effort. The backbone is
Claude's; the per-frame condition record came from Codex's; keeping the
keyboard on screen and rejecting dismissal came from Grok's.
