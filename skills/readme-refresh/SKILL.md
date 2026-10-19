---
name: readme-refresh
description: Refresh Expo Explore's README.md with euxy (github.com/brentvatne/euxy) as the reference app. Regenerate every screenshot and animated SVG in docs/screenshots from a current euxy review report and PR comment, then re-read the README as a first-time user: the top level only says what Explore does, links the live euxy example, gives one quick-start prompt to copy that reviews a change to your own app or explores a build you point it to, and one for setting up CI; everything else lives in collapsibles. Use after a Viewer or PR-comment change that the README shows, a new command or setting, or a release that made a README claim stale. Not for the docs/ guides or the shipped skills.
---

# Refresh the README

This is a repository-maintenance skill (it is not shipped in the npm package; `skills/explore-setup` and `skills/explore-binary` are). The reference app for every README example and screenshot is **euxy**, Brent's MIDI sequencer: it runs Explore on both platforms with hosted previews, so its PRs always have a current report and comment to photograph.

## 1. Pick the euxy report

The README's screenshots and its live example (`https://explore-example--euxy.expo.app/p/<token>`, deployed by `.github/workflows/example-report.yml`) must show the same report. The example serves the `viewer-preview-fixtures` release, the same reports every pull request's Viewer preview uses, so start there:

```sh
gh release download viewer-preview-fixtures --pattern reports.json --output - | jq -r '.[0] | "\(.target) \(.source)"'   # e.g. iphone brentvatne/euxy#163
mkdir -p ~/euxy-report && gh release download viewer-preview-fixtures --pattern iphone.zip --dir ~/euxy-report --clobber
```

Keep those fixtures when their euxy PR still shows a real change (an added or removed screen, modified screens with outlined regions). To move to a newer euxy PR, open its Explore comment and follow **iOS report** to the hosted link `https://euxy-explore--<id>.expo.app/p/<token>`. Then refresh the fixtures from that link and download them again:

```sh
scripts/refresh-viewer-preview-fixtures.sh '<hosted link>' brentvatne/euxy#<n>
```

Do not pick a same-tree demo PR, where every change is noise. The refreshed fixtures reach the live example on the next push to main, or when you run **Example report** from GitHub Actions. `curl -s "<hosted link>/api/v1/screens?status=added,removed,modified&platform=ios"` lists what changed, which tells you which screen to select and compare.

## 2. Regenerate every screenshot and animation

```sh
npm ci
node scripts/readme-screenshots.mjs --report ~/euxy-report/iphone.zip --select /lane-editor/0 --compare new-pattern --pr https://github.com/brentvatne/euxy/pull/<n>
```

- `--select` is the route the hero's pointer clicks on the Map (the Inspector opens on it): choose an added or clearly modified screen. The script zooms in around it, so it must be a screen the Map shows.
- `--compare` is the key in the Viewer's `#/compare/<key>` URL for a **modified** screen with outlined regions (open the report, click the screen in Compare, copy the key): the route without its slash. The script fails if the report has no visually modified screen at that route.
- `--pr` screenshots the Explore comment on that PR: the fixtures' `source`. Headless Chromium needs a colour emoji font for the result glyphs (`sudo apt-get install fonts-noto-color-emoji` on Debian/Ubuntu); a comment with hollow boxes where 🟩 should be is not acceptable.
- The script serves the report through the Viewer's Vite dev server, so no build is needed. It writes a `-light` and a `-dark` file for every picture (the PR comment too: signed-out github.com follows `prefers-color-scheme`). The README shows each pair with `<picture>`: a `<source media="(prefers-color-scheme: dark)">` for the dark file and an `<img>` with the alt text and the light file, which is what GitHub Mobile shows (it ignores the dark source), so the light file is the one that must always be right.

Two of the pictures are animated SVGs, built by `scripts/readme-animations.mjs` in the same run; there is nothing else to run when the screenshots change:

- `readme-hero-*.svg` is made of real Viewer frames at the zoomed Map camera: the Map without screens, the screens without edges, the whole Map, and the Map after the pointer clicks `--select`. The cards appear row by row, the edges wipe in from the top, then the pointer clicks and the Inspector slides in. Each is about 1.4 MB: four 2x JPEG frames inlined, since an SVG shown with `<img>` can load nothing. Anything the Viewer draws on the Map or in the Inspector shows up here on the next run, so regenerate it after a Viewer change the hero shows.
- `readme-compare-*.svg` is the `--compare` screen's base capture wiping to its head capture, with the report's changed regions pulsing. It is drawn from `review.json` and the report's assets, not from a Viewer screenshot, so a Viewer change does not stale it, but a new report does.
- Both loop on CSS keyframes, and with `prefers-reduced-motion` they hold the last frame: Inspector open, regions outlined. That frame is also what a viewer that does not animate SVG shows, so it must read on its own.

Open each SVG in a browser before committing, light and dark, and watch a full loop: every card should appear once and land where the whole Map has it, with no hover highlight in the frames before the click; the pointer should click the `--select` card; the Inspector should open on that screen; Compare's outlines should sit on the changed text, not beside it. To look at one moment, pause the animations in the console: `document.getAnimations().forEach(a => { a.pause(); a.currentTime = 5000; })`. Keep the README's `<img>` and `<source>` pointing at the `.svg` files.

`docs/screenshots/readme-exploration-light.png` is the black-box map and comes from a euxy `explore:binary` run (`npx @expo/explore explore:binary <euxy simulator build> --no-upload`, then `expo-explore view --dir <output>` at 1760×1000, Map, Fit canvas). It has no dark variant and is a plain Markdown image. Regenerate it when the Map's rendering of edges or labels changed; otherwise keep it, and say so in the PR.

`docs/screenshots/readme-reports-light.png` and `-dark.png` show `npx @expo/explore reports` in a terminal window on the same stage as the PR comment image. They are laid out in Paper (Brent's "Patient umbrella" file, page "README — reports picker image", one artboard per theme), from the real picker over real saved runs. Refresh them when the picker's layout or colours change:

```sh
npx @expo/explore reports list                                         # your saved runs: note a euxy local review's id
export EXPLORE_CACHE_DIR=$(mktemp -d)                                  # a scratch store for the image, not your own runs
cd ~/code/euxy                                                         # inside euxy, so the commit messages are found
npx @expo/explore reports add ~/.cache/expo-explore/reports/<that id>/ios.zip
npx @expo/explore reports add ~/euxy-report/iphone.zip                 # the PR report from step 1
npx @expo/explore reports add <an explore:binary report directory>     # an exploration, so all three kinds show
cd - && npm run build:cli && node scripts/readme-reports-rows.mjs > /tmp/reports-rows.html
```

- The script renders the picker as the CLI draws it (96 columns, the newest run selected) and writes the terminal body as HTML: each coloured piece is exactly its characters wide, so columns line up, and the wordmark is drawn as cell rectangles, since a design tool's font does not draw `█▀▄` cell for cell.
- In Paper, replace the frame named "Terminal" inside each artboard's window with that HTML, check both artboards in a screenshot (crisp wordmark, aligned columns, the selected row highlighted to the end, coloured counts), and export both at 2x as `readme-reports-light.png` and `readme-reports-dark.png`. The window's title bar reads `npx @expo/explore reports`, as people run it.

Look at every PNG you produced before committing, light and dark: the Screens grid must show the added, removed and modified status dots, the PR comment must show the heading links and result glyphs. Describe each in its Markdown alt text as what the picture shows, not what the feature is.

## 3. Pass over the content as a first-time user

Read the README top to bottom once without opening a collapsible. At that level it may only answer, in this order:

1. What Explore is (one short paragraph), the hero image, and the link to the live euxy example (`explore-example--euxy.expo.app`, redeployed on every merge to main by `.github/workflows/example-report.yml`). Under it, Compare at full width with a one-line caption, then one table row of two pictures with a one-line caption each: Screens and the PR comment (which says it needs CI), then the agent prompt collapsed as **Ask an agent about a report**. The hero is the animated zoomed Map, framed as a window on a stage, and Compare is the animated wipe (both from `readme-animations.mjs`); the Screens and PR comment pictures are PNGs. Compare gets its own row because a phone wiping from before to after is unreadable at a third of the column.
2. **Quick start**: one path. A single prompt to paste into Claude Code or Codex that reviews a change to the reader's own Expo app through the explore-setup skill's "Review a change on this machine" section, or, when they point it to a build (or the app is not an Expo project), explores a simulator build through the explore-binary skill. Then one sentence on what each case needs (a review needs an Expo account, is built on EAS, and is captured on EAS Simulator or a local simulator; exploring a build needs a Claude Code or Codex login and EAS Simulator or a local simulator, and no Expo account locally), and under it one `> [!NOTE]` alert: EAS Simulator is in preview, with the waitlist link and `--simulator local` as the alternative. Then one **Run it yourself** collapsible with both by hand: the numbered steps for a review, with nothing optional in them (make the app buildable on EAS: login, init, bundle identifier, a simulator profile named `explore`, and commit, since the before build is the last commit; then edit a screen near its top and run `capture`, or `capture --simulator local`), and the `explore:binary` commands, including `--simulator local`. Right after **Run it yourself**, one `> [!WARNING]` alert: a review runs both commits' code on the reader's machine, so review only commits they would run. These are the README's only two alerts; do not add more, or they stop standing out. Then the `reports` picker image (`readme-reports-*.png`) with one sentence on saved runs, at the top level, and one collapsible for other commits (`--committed`, `--base`/`--head`) and what a review does on the machine. Run the steps on a fresh `create-expo-app` before changing them.
3. **Map every screen of any app**: one sentence on what exploring a build shows (pointing back to the quick start, which runs it), then its collapsibles: its options, exploring a session already started, and what a run without source shows.
4. **Set up CI**: one sentence, then two subsections, each a sentence on what it gives and a prompt to paste: **Review on every PR** (the setup prompt, then a few grouped collapsibles: Hosted previews first, then Manual setup (the setup prompt's steps done by hand, in order: setup, doctor, secrets, baseline, first PR), Capture modes: deterministic or agent, iOS, Android, or both, Keep your setup current) and **Compare any two commits** (a prompt that follows the explore-setup skill's "Compare any two commits" section, the ways to snapshot a release as bullets, then the comparison workflow collapsed).

Lead with prompts, not explanations: a reader should be able to copy something and see Explore work. Everything else, the manual commands, requirements, options, the manual setup, capture modes, hosted previews, iOS and Android, agent mode, repository settings, how agents read a report, how it works, limitations, contributing, goes into a `<details>` block under the section it belongs to, with a `<summary>` that says what the reader will find. Keep bullets to one or two sentences. Group related collapsibles rather than adding one per topic, so a section shows a handful, not nine. Requirements sit collapsed right under the example report link. The **How it works** collapsible opens with a Mermaid `sequenceDiagram` of a PR review (pull request, GitHub Actions, EAS Build, EAS Simulator), followed by the facts it cannot show as bullets: who triggers a review, what Modified means, session retries. Check its steps against `CI-FLOW.md` and the `ci:*` commands, and edit the diagram's text, not a picture: GitHub draws it. Keep the collapsibles' `id` attributes that other docs link to (`#hosted-previews`, `#platforms`, `#compare`, `#agents`); the Terms and How agents read a report collapsibles live under Additional information, and keep the Inspiration section (screenmap and Revyl's Atlas).

Check that each prompt still works as written:
- the skill links it names (`https://unpkg.com/@expo/explore/skills/...`) are files the package ships (`files` in `package.json`), and they open from the published release;
- the commands and flags it names exist;
- the agent prompt matches what **Hand off to AI** writes (`handoffPrompt` in `viewer/src/utils/handoff.ts`).

While you are there, check every claim against the code: command names and flags against `expo-explore --help` and `src/cli.ts`, config keys against `docs/quickstart-ci.md`, version requirements against `package.json` and `doctor`'s checks, and the Viewer's view names and tab bar against what the screenshots show. Fix the README; do not describe a feature the screenshot does not show.

## 4. Check and open the PR

```sh
npm run lint
npx markdown-link-check README.md   # or click every relative link; all docs/ and skills/ paths must exist
```

Preview the Markdown (GitHub's renderer, or `npx marked README.md > /tmp/readme.html` and open it) and confirm that each collapsible opens and that the images are the new ones. Commit the README, the PNGs and any script change on one branch. In the PR description, say:
- which euxy PR the report came from;
- whether you refreshed the fixtures;
- which screenshots were regenerated and which were kept.

After the merge, open the README's example link and check it shows that report in the current Viewer.
