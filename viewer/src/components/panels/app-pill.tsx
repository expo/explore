import { appearanceLabel, type Appearance } from "../../utils/appearance";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { ExpoLogo } from "../shared/expo-logo";
import { Menu } from "../shared/menu";
import { isPreviewPath, isReportTargetId, previewReportsUrl, targetQuery } from "../../utils/artifact-report";
import { ScreenshotImage } from "../shared/screenshot-image";
import { artifactUrl } from "../../utils/model";
import { Tooltip } from "../shared/tooltip";
import { ChangesMenu } from "./changes-menu";
import type { FocusStatus } from "../../utils/navigation";
import type { ExploreMap, MapIndex } from "../../utils/model";
import type { BuildDiff } from "../../utils/build-diff";
import type { PullRequestPresentation } from "../../utils/review-model";

export const PLATFORM_NAMES: Record<string, string> = { ios: "iOS", android: "Android" };

/** What a hosted preview lists of each report it serves; listings from before targets name only the platform. */
type SiblingReport = { target: string; changes?: number; device?: string };
/** One report of the run, as the switch offers it. */
export type SwitchTarget = { id: string; platform: string; label: string };

/** The same review's report for another target: this page's URL with the target swapped (and the artifact id dropped). */
export function siblingReportUrl(page: URL, target: string): string | undefined {
  const preview = isPreviewPath(page.pathname);
  if (!preview && page.searchParams.get("origin") === "local") return undefined;
  if (!preview && !["repo", "run", "attempt"].every(key => page.searchParams.has(key))) return undefined;
  if (!isReportTargetId(target)) return undefined;
  const url = new URL(page.href);
  url.searchParams.delete("platform");
  url.searchParams.delete("target");
  const [key, value] = targetQuery(target).split("=") as [string, string];
  url.searchParams.set(key, value);
  url.searchParams.delete("artifact");
  url.searchParams.delete("screen");
  url.hash = "";
  return url.href;
}

/**
 * Every report of this report's run, in config order, and which one this is: `run.targets` with their labels, or for
 * reports from before targets one per platform of `run.platforms` (iOS first, as they list it). One report: none.
 */
export function runTargets(run: ExploreMap["run"]): { current: string; targets: SwitchTarget[] } {
  const current = run.target?.id ?? run.platform;
  if (run.targets && run.targets.length > 1) {
    return { current, targets: run.targets.filter(target => isReportTargetId(target.id)).map(target => ({ id: target.id, platform: target.platform,
      label: target.label?.trim() || (target.id === target.platform ? PLATFORM_NAMES[target.platform] ?? target.id : target.id) })) };
  }
  const platforms = (run.platforms ?? []).filter(platform => platform in PLATFORM_NAMES);
  return { current, targets: platforms.length > 1 ? platforms.map(platform => ({ id: platform, platform, label: PLATFORM_NAMES[platform]! })) : [] };
}

/** On a hosted preview, the deployment lists what it serves per target; elsewhere only the targets' names are known. */
function useSiblingReports(page: URL | undefined): SiblingReport[] | undefined {
  const [reports, setReports] = useState<SiblingReport[]>();
  const url = page ? previewReportsUrl(page) : undefined;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" }).then(response => response.ok ? response.json() : undefined).then((list: unknown) => {
      if (cancelled || !Array.isArray(list)) return;
      setReports(list.flatMap(entry => {
        if (typeof entry !== "object" || entry === null) return [];
        const { target, platform, changes, device } = entry as Record<string, unknown>;
        const id = target ?? platform;
        return isReportTargetId(id) ? [{ target: id, ...(typeof changes === "number" ? { changes } : {}), ...(typeof device === "string" ? { device } : {}) }] : [];
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [url]);
  return reports;
}

type AppPillProps = {
  /** The phone layout puts Search in the pill, at its trailing edge. */
  onOpenSearch?: (() => void) | undefined;
  /** Actions at the trailing edge, before Search on phones: Hand off to AI. */
  trailing?: ReactNode;
  map: ExploreMap;
  index: MapIndex;
  selectedScreenId?: string;
  pullRequest?: PullRequestPresentation;
  focus: FocusStatus[];
  focusCounts: Record<FocusStatus, number>;
  diff?: BuildDiff;
  changesOpen: boolean;
  onChangesOpen: (open: boolean) => void;
  onChangeFocus: (focus: FocusStatus[]) => void;
  onOpenChangedScreen: (screenId: string) => void;
  onReviewAll: () => void;
  onOpenMap: () => void;
  /** Compare anchors the Changes menu to its title, so the pill does not anchor it there. */
  hideChanges?: boolean;
  /** Reports captured in several appearances switch between them here. */
  appearance?: { current: Appearance; options: Appearance[]; onChange: (appearance: Appearance) => void };
};


/**
 * The Viewer's only chrome on the left: the Expo mark (back to the map), the app and its pull
 * request. ⌘B opens the Changes menu under it; Compare's title and the bottom bar's Compare
 * button are the visible ways into the changes.
 */
export function AppPill(props: AppPillProps) {
  const pillRef = useRef<HTMLDivElement>(null);
  const platformRef = useRef<HTMLButtonElement>(null);
  const [platformOpen, setPlatformOpen] = useState(false);
  const appearanceRef = useRef<HTMLButtonElement>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceItems = (props.appearance?.options ?? []).map(option => ({
    kind: "item" as const, label: appearanceLabel(option), checked: option === props.appearance?.current,
    onSelect: () => { setAppearanceOpen(false); props.appearance?.onChange(option); },
  }));
  const page = typeof window === "undefined" ? undefined : new URL(window.location.href);
  const siblingReports = useSiblingReports(page);
  const applicationName = props.map.run.name;
  // The app's own icon when the report carries one; the Expo mark otherwise.
  const appIcon = artifactUrl(props.map.run.appIcon);
  const platform = props.map.run.platform;
  const environment = props.map.run.environment ?? {};
  const device = [
    environment.osVersion ? `${PLATFORM_NAMES[platform] ?? platform} ${environment.osVersion}` : PLATFORM_NAMES[platform] ?? platform,
    environment.deviceModel,
  ].filter(Boolean).join(" · ");
  const pullRequest = props.pullRequest;
  const changeCount = props.diff
    ? Object.values(props.focusCounts).reduce((total, count) => total + count, 0)
    : 0;
  const prDetails = pullRequest
    ? `${pullRequest.title}\n${pullRequest.head.ref} → ${pullRequest.base.ref}\n${device}`
    : device;
  // The URL is validated as https://github.com/owner/repo/pull/N (or /compare/<base>..<head>), so its parent is the repository.
  const repositoryUrl = pullRequest?.url && pullRequest.origin !== "local" ? pullRequest.url.replace(/\/(pull\/\d+|compare\/.+)$/, "") : undefined;
  const appTitle = device ? `${applicationName} · ${device}` : applicationName;
  // Reports of a run with several targets name every target; the others are one menu away, in config order.
  const run = runTargets(props.map.run);
  const currentTarget = run.targets.find(target => target.id === run.current);
  const targetLabel = currentTarget?.label ?? PLATFORM_NAMES[platform] ?? platform;
  // Platform-named targets (every report from before targets) switch platforms; named targets switch devices.
  const noun = run.targets.every(target => target.id === target.platform) ? "platform" : "device";
  const siblings = run.targets
    .filter(target => target.id !== run.current)
    .map(target => ({ target, url: page ? siblingReportUrl(page, target.id) : undefined, report: siblingReports?.find(report => report.target === target.id) }))
    .filter((entry): entry is { target: SwitchTarget; url: string; report: SiblingReport | undefined } => Boolean(entry.url));
  const platformItems = siblings.length ? run.targets.flatMap(target => {
    if (target.id === run.current) return [{ kind: "item" as const, label: target.label, description: device || undefined, checked: true, onSelect: () => setPlatformOpen(false) }];
    const sibling = siblings.find(entry => entry.target.id === target.id);
    return sibling ? [{
      kind: "item" as const, label: target.label,
      description: [sibling.report?.changes === undefined ? undefined : `${sibling.report.changes} ${sibling.report.changes === 1 ? "change" : "changes"}`, sibling.report?.device]
        .filter(Boolean).join(" · ") || (target.platform === platform ? "Same review, other device" : "Same review, other platform"),
      checked: false, onSelect: () => { setPlatformOpen(false); window.location.assign(sibling.url); },
    }] : [];
  }) : [];
  // A report whose target is not among the run's (a hand-edited one) still lists itself first, checked.
  if (siblings.length && !currentTarget) platformItems.unshift({ kind: "item" as const, label: targetLabel, description: device || undefined, checked: true, onSelect: () => setPlatformOpen(false) });

  return (
    <div className="left-panel collapsed">
      <div ref={pillRef} className="left-panel-collapsed-pill">
        <Tooltip label="Map">
          <button type="button" className="panel-logo-button" aria-label="Map" onClick={props.onOpenMap}>
            {appIcon ? (
              <ScreenshotImage className="panel-app-icon" src={appIcon} alt="" loading="eager" draggable={false}
                fallback={<ExpoLogo mark />} />
            ) : <ExpoLogo mark />}
          </button>
        </Tooltip>
        <span className="panel-logo-divider" aria-hidden="true" />
        <div className="collapsed-app-identity">
          <strong title={appTitle}>
            {repositoryUrl ? (
              <a className="collapsed-app-name" href={repositoryUrl} target="_blank" rel="noreferrer noopener"
                aria-label={`${applicationName} repository on GitHub`}>
                {applicationName}
              </a>
            ) : applicationName}
          </strong>
          {siblings.length ? (
            <>
              <Tooltip label={`${device || targetLabel} · open another ${noun}'s report`} placement="bottom">
                <button ref={platformRef} type="button" className="collapsed-platform" aria-haspopup="menu" aria-expanded={platformOpen}
                  aria-label={`${noun === "device" ? "Device" : "Platform"}: ${targetLabel}. Open another ${noun}'s report`}
                  onClick={() => setPlatformOpen(open => !open)}>
                  {targetLabel}
                  <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </Tooltip>
              <Menu items={platformItems} open={platformOpen} anchorRef={platformRef} ariaLabel={noun === "device" ? "Device" : "Platform"} onDismiss={() => setPlatformOpen(false)} />
            </>
          ) : null}
          {props.appearance ? (
            <>
              <Tooltip label="Appearance · the same screens captured in the other scheme" placement="bottom">
                <button ref={appearanceRef} type="button" className="collapsed-platform" aria-haspopup="menu" aria-expanded={appearanceOpen}
                  aria-label={`Appearance: ${appearanceLabel(props.appearance.current)}. Show the other appearance`}
                  onClick={() => setAppearanceOpen(open => !open)}>
                  {appearanceLabel(props.appearance.current)}
                  <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </Tooltip>
              <Menu items={appearanceItems} open={appearanceOpen} anchorRef={appearanceRef} ariaLabel="Appearance" onDismiss={() => setAppearanceOpen(false)} />
            </>
          ) : null}
          {pullRequest?.origin === "compare" ? (
            <Tooltip label={prDetails} placement="bottom">
              <a
                className="collapsed-pr"
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${pullRequest.title} on GitHub`}>
                {pullRequest.title}
              </a>
            </Tooltip>
          ) : pullRequest && pullRequest.origin !== "local" ? (
            <Tooltip label={prDetails} placement="bottom">
              <a
                className="collapsed-pr"
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`PR #${pullRequest.number} on GitHub`}>
                PR #{pullRequest.number}
              </a>
            </Tooltip>
          ) : pullRequest ? (
            <Tooltip label={prDetails} placement="bottom">
              <span className="collapsed-pr">Local</span>
            </Tooltip>
          ) : null}
        </div>
        {props.trailing}
        {props.onOpenSearch ? (
          <button type="button" className="collapsed-search" aria-label="Search" onClick={props.onOpenSearch}>
            <Search aria-hidden="true" />
          </button>
        ) : null}
        {/* No chip: Compare's title opens the Changes menu, and ⌘B opens it here, under the pill. */}
        {props.diff && changeCount > 0 && !props.hideChanges ? (
          <ChangesMenu
            diff={props.diff}
            index={props.index}
            selectedScreenId={props.selectedScreenId}
            focus={props.focus}
            focusCounts={props.focusCounts}
            onChangeFocus={props.onChangeFocus}
            onOpenChangedScreen={props.onOpenChangedScreen}
            onReviewAll={props.onReviewAll}
            open={props.changesOpen}
            anchorRef={pillRef}
            onDismiss={() => props.onChangesOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
