import { appearanceLabel, type Appearance } from "../../utils/appearance";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { ExpoLogo } from "../shared/expo-logo";
import { Menu } from "../shared/menu";
import { isPreviewPath, previewReportsUrl, type ReportPlatform } from "../../utils/artifact-report";
import { ScreenshotImage } from "../shared/screenshot-image";
import { artifactUrl } from "../../utils/model";
import { Tooltip } from "../shared/tooltip";
import { ChangesMenu } from "./changes-menu";
import type { FocusStatus } from "../../utils/navigation";
import type { ExploreMap, MapIndex } from "../../utils/model";
import type { BuildDiff } from "../../utils/build-diff";
import type { PullRequestPresentation } from "../../utils/review-model";

export const PLATFORM_NAMES: Record<string, string> = { ios: "iOS", android: "Android" };

type SiblingReport = { platform: ReportPlatform; changes?: number; device?: string };

/** The same review's report for another platform: this page's URL with `platform` swapped (and the artifact id dropped). */
export function siblingReportUrl(page: URL, platform: ReportPlatform): string | undefined {
  const preview = isPreviewPath(page.pathname);
  if (!preview && page.searchParams.get("origin") === "local") return undefined;
  if (!preview && !["repo", "run", "attempt"].every(key => page.searchParams.has(key))) return undefined;
  const url = new URL(page.href);
  url.searchParams.set("platform", platform);
  url.searchParams.delete("artifact");
  url.searchParams.delete("screen");
  url.hash = "";
  return url.href;
}

/** On a hosted preview, the deployment lists what it serves per platform; elsewhere only the platform names are known. */
function useSiblingReports(page: URL | undefined): SiblingReport[] | undefined {
  const [reports, setReports] = useState<SiblingReport[]>();
  const url = page ? previewReportsUrl(page) : undefined;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" }).then(response => response.ok ? response.json() : undefined).then((list: unknown) => {
      if (cancelled || !Array.isArray(list)) return;
      setReports(list.filter((entry): entry is SiblingReport => typeof entry === "object" && entry !== null
        && (entry as SiblingReport).platform in PLATFORM_NAMES));
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
  // Reports of a multi-platform review name every platform; the other ones are one menu away.
  const siblings = (props.map.run.platforms ?? [])
    .filter((entry): entry is ReportPlatform => entry !== platform && entry in PLATFORM_NAMES)
    .map(entry => ({ platform: entry, url: page ? siblingReportUrl(page, entry) : undefined, report: siblingReports?.find(report => report.platform === entry) }))
    .filter((entry): entry is { platform: ReportPlatform; url: string; report: SiblingReport | undefined } => Boolean(entry.url));
  const platformItems = siblings.length ? [
    { kind: "item" as const, label: PLATFORM_NAMES[platform] ?? platform, description: device || undefined, checked: true, onSelect: () => setPlatformOpen(false) },
    ...siblings.map(sibling => ({
      kind: "item" as const, label: PLATFORM_NAMES[sibling.platform]!,
      description: [sibling.report?.changes === undefined ? undefined : `${sibling.report.changes} ${sibling.report.changes === 1 ? "change" : "changes"}`, sibling.report?.device]
        .filter(Boolean).join(" · ") || "Same review, other platform",
      checked: false, onSelect: () => { setPlatformOpen(false); window.location.assign(sibling.url); },
    })),
  ] : [];

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
              <Tooltip label={`${device || PLATFORM_NAMES[platform] || platform} · open another platform's report`} placement="bottom">
                <button ref={platformRef} type="button" className="collapsed-platform" aria-haspopup="menu" aria-expanded={platformOpen}
                  aria-label={`Platform: ${PLATFORM_NAMES[platform] ?? platform}. Open another platform's report`}
                  onClick={() => setPlatformOpen(open => !open)}>
                  {PLATFORM_NAMES[platform] ?? platform}
                  <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </Tooltip>
              <Menu items={platformItems} open={platformOpen} anchorRef={platformRef} ariaLabel="Platform" onDismiss={() => setPlatformOpen(false)} />
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
