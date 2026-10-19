import type { ExploreMap } from "../../utils/model";

/**
 * The Map and Screens with no screen to show. A run that observed none says what stopped it; a public report whose routes
 * were all deliberately left uncaptured (omitted-screens.ts) says so, rather than showing an empty page.
 */
export function NoScreens(props: { map: ExploreMap }) {
  const recorded = props.map.screens.length > 0;
  const blockers = props.map.gaps.filter((gap) => gap.status === "open" && !gap.screenId).map((gap) => gap.message);
  return (
    <div className="graph-canvas canvas-empty">
      <div className="page-empty compact-empty map-empty" role="status">
        <h2>{recorded ? "No screens were captured" : "No screens were recorded"}</h2>
        {recorded
          ? <p>Every route in this report is a redirect, is named in exploration.exclude, or is outside what the change reaches.</p>
          : blockers.length > 0
            ? blockers.map((message) => <p key={message}>{message}</p>)
            : <p>The run ended before any screen of the app was observed.</p>}
      </div>
    </div>
  );
}
