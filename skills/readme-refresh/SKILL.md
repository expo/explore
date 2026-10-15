---
name: readme-refresh
description: Refresh Expo Explore's README.md with euxy (github.com/brentvatne/euxy) as the reference app. Regenerate every screenshot in docs/screenshots from a current euxy review report and PR comment, then re-read the README as a first-time user: the top level only says what Explore does, links the live euxy example, and gives a prompt to copy for trying it on your app and one for setting up CI; everything else lives in collapsibles. Use after a Viewer or PR-comment change that the README shows, a new command or setting, or a release that made a README claim stale. Not for the docs/ guides or the shipped skills.
---

# Refresh the README

This is a repository-maintenance skill (it is not shipped in the npm package; `skills/explore-setup` and `skills/explore-binary` are). The reference app for every README example and screenshot is **euxy**, Brent's MIDI sequencer: it runs Explore on both platforms with hosted previews, so its PRs always have a current report and comment to photograph.

## 1. Pick the euxy report

The README's screenshots and its live example (`https://explore-example--euxy.expo.app/p/<token>`, deployed by `.github/workflows/example-report.yml`) must show the same report. The example serves the `viewer-preview-fixtures` release, the same reports every pull request's Viewer preview uses, so start there:

```sh
gh release download viewer-preview-fixtures --pattern reports.json --output - | jq -r '.[0].source'   # e.g. brentvatne/euxy#154
mkdir -p ~/euxy-report && gh release download viewer-preview-fixtures --pattern ios.zip --dir ~/euxy-report --clobber
```

Keep those fixtures when their euxy PR still shows a real change (an added or removed screen, modified screens with outlined regions). To move to a newer euxy PR, open its Explore comment and follow **iOS report** to the hosted link `https://euxy-explore--<id>.expo.app/p/<token>`. Then refresh the fixtures from that link and download them again:

```sh
scripts/refresh-viewer-preview-fixtures.sh '<hosted link>' brentvatne/euxy#<n>
```

Do not pick a same-tree demo PR, where every change is noise. The refreshed fixtures reach the live example on the next push to main, or when you run **Example report** from GitHub Actions. `curl -s "<hosted link>/api/v1/screens?status=added,removed,modified&platform=ios"` lists what changed, which tells you which screen to select and compare.

## 2. Regenerate every screenshot

```sh
npm ci
node scripts/readme-screenshots.mjs --report ~/euxy-report/ios.zip --select /settings --compare patterns --pr https://github.com/brentvatne/euxy/pull/<n>
```

- `--select` is the route selected on the hero Map (the Inspector opens on it): choose an added or clearly modified screen.
- `--compare` is the key in the Viewer's `#/compare/<key>` URL for a **modified** screen with outlined regions (open the report, click the screen in Compare, copy the key). The script fails if the key is not in the report.
- `--pr` screenshots the Explore comment on that PR: the fixtures' `source`. Headless Chromium needs a colour emoji font for the result glyphs (`sudo apt-get install fonts-noto-color-emoji` on Debian/Ubuntu); a comment with hollow boxes where 🟩 should be is not acceptable.
- The script serves the report through the Viewer's Vite dev server, so no build is needed. It writes a `-light` and a `-dark` PNG for every shot (the PR comment too: signed-out github.com follows `prefers-color-scheme`). The README shows each pair with `<picture>`: a `<source media="(prefers-color-scheme: dark)">` for the dark file and an `<img>` with the alt text and the light file, which is what GitHub Mobile shows (it ignores the dark source), so the light file is the one that must always be right.

`docs/screenshots/readme-exploration-light.png` is the black-box map and comes from a euxy `explore:binary` run (`npx @expo/explore explore:binary <euxy simulator build> --no-upload`, then `expo-explore view --dir <output>` at 1760×1000, Map, Fit canvas). It has no dark variant and is a plain Markdown image. Regenerate it when the Map's rendering of edges or labels changed; otherwise keep it, and say so in the PR.

`docs/screenshots/readme-reports-light.png` and `-dark.png` show `npx @expo/explore reports` in a terminal window on the same stage as the PR comment image. They are laid out in Paper (Brent's "Patient umbrella" file, page "README — reports picker image", one artboard per theme), from the real picker over real saved runs. Refresh them when the picker's layout or colours change:

```sh
npx @expo/explore reports list                                         # your saved runs: note a euxy local review's id
export EXPLORE_CACHE_DIR=$(mktemp -d)                                  # a scratch store for the image, not your own runs
cd ~/code/euxy                                                         # inside euxy, so the commit messages are found
npx @expo/explore reports add ~/.cache/expo-explore/reports/<that id>/ios.zip
npx @expo/explore reports add ~/euxy-report/ios.zip                    # the PR report from step 1
npx @expo/explore reports add <an explore:binary report directory>     # an exploration, so all three kinds show
cd - && npm run build:cli && node scripts/readme-reports-rows.mjs > /tmp/reports-rows.html
```

- The script renders the picker as the CLI draws it (96 columns, the newest run selected) and writes the terminal body as HTML: each coloured piece is exactly its characters wide, so columns line up, and the wordmark is drawn as cell rectangles, since a design tool's font does not draw `█▀▄` cell for cell.
- In Paper, replace the frame named "Terminal" inside each artboard's window with that HTML, check both artboards in a screenshot (crisp wordmark, aligned columns, the selected row highlighted to the end, coloured counts), and export both at 2x as `readme-reports-light.png` and `readme-reports-dark.png`. The window's title bar reads `npx @expo/explore reports`, as people run it.

Look at every PNG you produced before committing, light and dark: the selected screen should be the one you asked for, the Compare view must show Before and After with outlines, the Screens grid must show the Added/Removed/Modified badges, the PR comment must show the heading links and result glyphs. Describe each in its Markdown alt text as what the picture shows, not what the feature is.

## 3. Pass over the content as a first-time user

Read the README top to bottom once without opening a collapsible. At that level it may only answer, in this order:

1. What Explore is (one short paragraph), the hero image, and the link to the live euxy example (`explore-example--euxy.expo.app`, redeployed on every merge to main by `.github/workflows/example-report.yml`).
2. **Try it on your app**: one sentence and a prompt to paste into Claude Code or Codex that gets a simulator build of any app (Expo or not, or just a build) and runs `explore:binary` on it. Under it, **Review a change before you push it**: one sentence and a prompt that runs `capture:review` locally (the explore-setup skill's "Review a change on this machine" section) on a set-up app.
3. **Set up CI: reviews on every PR**: one sentence and the setup prompt.
4. **What you get**: the PR comment, Compare, and Screens, each a heading, one line, and its picture, then a prompt for asking an agent about a report.

Lead with prompts, not explanations: a reader should be able to copy something and see Explore work. Everything else, the manual commands, requirements, options, the manual setup, capture modes, hosted previews, several platforms, agent mode, repository settings, how agents read a report, how it works, limitations, contributing, goes into a `<details>` block under the section it belongs to, with a `<summary>` that says what the reader will find. Keep bullets to one or two sentences. Keep the collapsibles' `id` attributes that other docs link to (`#hosted-previews`, `#platforms`, `#agents`), and keep the Inspiration section (screenmap and Revyl's Atlas).

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
