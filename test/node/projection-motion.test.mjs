import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const motion = await tsImport(
  "../../viewer/src/components/canvas/projection-motion.ts",
  import.meta.url,
);

function metadata(overrides) {
  return {
    motionKey: overrides.motionKey,
    role: overrides.role,
    representedScreenIds: overrides.representedScreenIds,
    areaId: overrides.areaId,
    representativeScreenId: overrides.representativeScreenId,
    areaRepresentativeScreenId: overrides.areaRepresentativeScreenId,
    ...(overrides.branchId ? { branchId: overrides.branchId } : {}),
    ...(overrides.branchRepresentativeScreenId
      ? { branchRepresentativeScreenId: overrides.branchRepresentativeScreenId }
      : {}),
  };
}

function node(id, position, size, projectionMotion, className) {
  return {
    id,
    position,
    width: size.width,
    height: size.height,
    data: { projectionMotion },
    ...(className ? { className } : {}),
  };
}

const areaMotion = metadata({
  motionKey: "area:banking",
  role: "summary",
  representedScreenIds: ["banking-root", "banking-child"],
  areaId: "banking",
  representativeScreenId: "banking-root",
  areaRepresentativeScreenId: "banking-root",
});
const rootMotion = metadata({
  motionKey: "screen:banking-root",
  role: "screen",
  representedScreenIds: ["banking-root"],
  areaId: "banking",
  branchId: "banking-flow",
  areaRepresentativeScreenId: "banking-root",
  branchRepresentativeScreenId: "banking-root",
});
const childMotion = metadata({
  motionKey: "screen:banking-child",
  role: "screen",
  representedScreenIds: ["banking-child"],
  areaId: "banking",
  branchId: "banking-flow",
  areaRepresentativeScreenId: "banking-root",
  branchRepresentativeScreenId: "banking-root",
});

function center(candidate) {
  return motion.projectionNodeCenter(candidate);
}

const screenScale = node => node.data?.projectionScreenScale ?? 1;

test("expands children from their semantic area card before moving to final slots", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const nextSummary = node("summary-banking", { x: 420, y: 80 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 280 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);

  const frames = motion.projectionTransitionFrames([nextSummary, root, child], [summary], {
    fromLevel: "overview",
    toLevel: "detail",
  });
  const preparedRoot = frames.prepared.find((candidate) => candidate.id === root.id);
  const preparedChild = frames.prepared.find((candidate) => candidate.id === child.id);
  assert.deepEqual(center(preparedRoot), center(summary));
  assert.deepEqual(center(preparedChild), center(summary));
  assert.match(preparedRoot.className, /canvas-node-enter/);
  assert.match(preparedChild.className, /canvas-node-enter/);
  assert.deepEqual(frames.active.find((candidate) => candidate.id === root.id).position, root.position);
  assert.deepEqual(frames.active.find((candidate) => candidate.id === child.id).position, child.position);
});

test("App areas expansion is the exact crossfade reverse of Highlights collapse", () => {
  const groups = [
    { areaId: "alpha", count: 2 },
    { areaId: "beta", count: 5 },
    { areaId: "gamma", count: 11 },
  ];
  const current = [];
  const next = [];
  const expectedFadeIds = [];

  groups.forEach(({ areaId, count }, areaIndex) => {
    const screenIds = Array.from({ length: count }, (_, index) => `${areaId}-${index}`);
    const summaryMotion = metadata({
      motionKey: `area:${areaId}`,
      role: "summary",
      representedScreenIds: screenIds,
      areaId,
      representativeScreenId: screenIds[0],
      areaRepresentativeScreenId: screenIds[0],
    });
    const summary = node(
      `summary-${areaId}`,
      { x: areaIndex * 500, y: areaIndex * 140 },
      { width: 220, height: 118 },
      summaryMotion,
    );
    current.push(summary);
    next.push(node(
      summary.id,
      { x: areaIndex * 540, y: areaIndex * 180 },
      { width: 220, height: 118 },
      summaryMotion,
    ));
    screenIds.forEach((screenId, screenIndex) => {
      const screen = node(
        screenId,
        { x: areaIndex * 760 + screenIndex * 210, y: 420 + areaIndex * 460 },
        { width: 184, height: 420 },
        metadata({
          motionKey: `screen:${screenId}`,
          role: "screen",
          representedScreenIds: [screenId],
          areaId,
          areaRepresentativeScreenId: screenIds[0],
        }),
      );
      next.push(screen);
      expectedFadeIds.push(screenId);
    });
  });

  const frames = motion.projectionTransitionFrames(next, current, {
    fromLevel: "overview",
    toLevel: "structure",
  });
  for (const screenId of expectedFadeIds) {
    const prepared = frames.prepared.find((candidate) => candidate.id === screenId);
    const destination = next.find((candidate) => candidate.id === screenId);
    assert.deepEqual(prepared.position, destination.position);
    assert.equal(motion.projectionNodeFadeOnly(prepared), true);
    assert.equal(motion.projectionNodeDelay(prepared), 0);
  }
  for (const { areaId } of groups) {
    const sourceSummary = current.find((candidate) => candidate.id === `summary-${areaId}`);
    const preparedSummary = frames.prepared.find((candidate) => candidate.id === sourceSummary.id);
    const activeSummary = frames.active.find((candidate) => candidate.id === sourceSummary.id);
    assert.deepEqual(preparedSummary.position, sourceSummary.position);
    assert.deepEqual(activeSummary.position, next.find((candidate) => candidate.id === sourceSummary.id).position);
  }
});

test("Highlights collapse keeps shared summaries spatial and fades every screen in place", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 280 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);

  const frames = motion.projectionTransitionFrames([summary], [summary, root, child], {
    fromLevel: "structure",
    toLevel: "overview",
  });
  const exitingRoot = frames.active.find((candidate) => candidate.id === root.id);
  const exitingChild = frames.active.find((candidate) => candidate.id === child.id);
  assert.deepEqual(exitingRoot.position, root.position);
  assert.equal(motion.projectionNodeFadeOnly(exitingRoot), true);
  assert.equal(motion.projectionNodeDelay(exitingRoot), 0);
  assert.deepEqual(exitingChild.position, child.position);
  assert.equal(motion.projectionNodeFadeOnly(exitingChild), true);
  assert.equal(motion.projectionNodeDelay(exitingChild), 0);
});

test("target-first FLIP preserves source pixels before moving summaries in screen space", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const nextSummary = node("summary-banking", { x: 700, y: 80 }, { width: 220, height: 118 }, areaMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);
  const sourceViewport = { x: 10, y: 20, zoom: 0.5 };
  const targetViewport = { x: 100, y: 200, zoom: 2 };
  const base = motion.projectionTransitionFrames([nextSummary], [summary, child], {
    fromLevel: "structure",
    toLevel: "overview",
  });
  const frames = motion.projectionScreenSpaceFrames(base, sourceViewport, targetViewport);
  const preparedSummary = frames.prepared.find((candidate) => candidate.id === summary.id);
  const preparedChild = frames.prepared.find((candidate) => candidate.id === child.id);
  const activeSummary = frames.active.find((candidate) => candidate.id === summary.id);
  const activeChild = frames.active.find((candidate) => candidate.id === child.id);
  const sourceScreenCenter = (candidate) => ({
    x: center(candidate).x * sourceViewport.zoom + sourceViewport.x,
    y: center(candidate).y * sourceViewport.zoom + sourceViewport.y,
  });
  const targetScreenCenter = (candidate) => ({
    x: center(candidate).x * targetViewport.zoom + targetViewport.x,
    y: center(candidate).y * targetViewport.zoom + targetViewport.y,
  });

  assert.deepEqual(targetScreenCenter(preparedSummary), sourceScreenCenter(summary));
  assert.deepEqual(targetScreenCenter(preparedChild), sourceScreenCenter(child));
  assert.equal(screenScale(preparedSummary), 0.25);
  assert.equal(screenScale(preparedChild), 0.25);
  assert.equal(motion.projectionNodeMotions(preparedSummary).length, 0);
  assert.equal(motion.projectionNodeMotions(preparedChild).length, 0);
  assert.deepEqual(activeSummary.position, nextSummary.position);
  assert.equal(screenScale(activeSummary), 1);
  assert.deepEqual(activeChild.position, preparedChild.position);
  assert.equal(screenScale(activeChild), 0.25);
  assert.match(activeChild.className, /canvas-node-exit/);
  assert.equal(motion.projectionNodeFadeOnly(activeChild), true);
});

test("App areas and Highlights reuse the same screen-space path in reverse", () => {
  const overviewSummary = node(
    "summary-banking",
    { x: 100, y: 200 },
    { width: 220, height: 118 },
    areaMotion,
  );
  const highlightSummary = node(
    "summary-banking",
    { x: 700, y: 80 },
    { width: 220, height: 118 },
    areaMotion,
  );
  const screen = node(
    "banking-child",
    { x: 680, y: 280 },
    { width: 184, height: 420 },
    childMotion,
  );
  const overviewViewport = { x: 80, y: 140, zoom: 1.25 };
  const highlightViewport = { x: -20, y: 30, zoom: 0.5 };
  const expansion = motion.projectionScreenSpaceFrames(
    motion.projectionTransitionFrames(
      [highlightSummary, screen],
      [overviewSummary],
      { fromLevel: "overview", toLevel: "structure" },
    ),
    overviewViewport,
    highlightViewport,
  );
  const collapse = motion.projectionScreenSpaceFrames(
    motion.projectionTransitionFrames(
      [overviewSummary],
      [highlightSummary, screen],
      { fromLevel: "structure", toLevel: "overview" },
    ),
    highlightViewport,
    overviewViewport,
  );
  const expansionPreparedSummary = expansion.prepared.find((candidate) => (
    candidate.id === overviewSummary.id
  ));
  const collapsePreparedSummary = collapse.prepared.find((candidate) => (
    candidate.id === overviewSummary.id
  ));
  const screenPoint = (candidate, viewport) => ({
    x: center(candidate).x * viewport.zoom + viewport.x,
    y: center(candidate).y * viewport.zoom + viewport.y,
  });

  assert.deepEqual(
    screenPoint(expansionPreparedSummary, highlightViewport),
    screenPoint(overviewSummary, overviewViewport),
  );
  assert.deepEqual(
    screenPoint(collapsePreparedSummary, overviewViewport),
    screenPoint(highlightSummary, highlightViewport),
  );
  assert.deepEqual(
    expansion.active.find((candidate) => candidate.id === overviewSummary.id).position,
    highlightSummary.position,
  );
  assert.deepEqual(
    collapse.active.find((candidate) => candidate.id === overviewSummary.id).position,
    overviewSummary.position,
  );
  assert.equal(
    screenScale(expansionPreparedSummary)
      * screenScale(collapsePreparedSummary),
    1,
  );
  const enteringScreen = expansion.prepared.find((candidate) => candidate.id === screen.id);
  const exitingScreen = collapse.active.find((candidate) => candidate.id === screen.id);
  assert.deepEqual(enteringScreen.position, screen.position);
  assert.equal(motion.projectionNodeFadeOnly(enteringScreen), true);
  assert.equal(motion.projectionNodeDelay(enteringScreen), 0);
  assert.equal(motion.projectionNodeFadeOnly(exitingScreen), true);
  assert.equal(motion.projectionNodeDelay(exitingScreen), 0);
});

test("Highlights and Flow detail reuse the same screen-space path in reverse", () => {
  const structureSummary = node(
    "summary-banking",
    { x: 100, y: 200 },
    { width: 220, height: 118 },
    areaMotion,
  );
  const detailSummary = node(
    "summary-banking",
    { x: 860, y: 120 },
    { width: 220, height: 118 },
    areaMotion,
  );
  const structureRoot = node(
    "banking-root",
    { x: 380, y: 260 },
    { width: 184, height: 420 },
    rootMotion,
  );
  const detailRoot = node(
    "banking-root",
    { x: 120, y: 80 },
    { width: 184, height: 420 },
    rootMotion,
  );
  const branchSummaryMotion = metadata({
    motionKey: "summary:banking-child",
    role: "summary",
    representedScreenIds: ["banking-child"],
    areaId: "banking",
    representativeScreenId: "banking-child",
    areaRepresentativeScreenId: "banking-root",
  });
  const branchSummary = node(
    "summary-banking-child",
    { x: 660, y: 240 },
    { width: 220, height: 118 },
    branchSummaryMotion,
  );
  const detailChild = node(
    "banking-child",
    { x: 420, y: 80 },
    { width: 184, height: 420 },
    childMotion,
  );
  const structure = [structureSummary, structureRoot, branchSummary];
  const detail = [detailSummary, detailRoot, detailChild];
  const structureViewport = { x: 70, y: 110, zoom: 0.6 };
  const detailViewport = { x: -40, y: 20, zoom: 0.9 };
  const forward = motion.projectionScreenSpaceFrames(
    motion.projectionTransitionFrames(detail, structure, {
      fromLevel: "structure",
      toLevel: "detail",
    }),
    structureViewport,
    detailViewport,
  );
  const reverse = motion.projectionScreenSpaceFrames(
    motion.projectionTransitionFrames(structure, detail, {
      fromLevel: "detail",
      toLevel: "structure",
    }),
    detailViewport,
    structureViewport,
  );
  const screenPoint = (candidate, viewport) => ({
    x: center(candidate).x * viewport.zoom + viewport.x,
    y: center(candidate).y * viewport.zoom + viewport.y,
  });

  for (const [structureNode, detailNode] of [
    [structureSummary, detailSummary],
    [structureRoot, detailRoot],
  ]) {
    const forwardPrepared = forward.prepared.find((candidate) => (
      candidate.id === structureNode.id
    ));
    const reversePrepared = reverse.prepared.find((candidate) => (
      candidate.id === detailNode.id
    ));
    assert.deepEqual(
      screenPoint(forwardPrepared, detailViewport),
      screenPoint(structureNode, structureViewport),
    );
    assert.deepEqual(
      screenPoint(reversePrepared, structureViewport),
      screenPoint(detailNode, detailViewport),
    );
    assert.deepEqual(
      forward.active.find((candidate) => candidate.id === detailNode.id).position,
      detailNode.position,
    );
    assert.deepEqual(
      reverse.active.find((candidate) => candidate.id === structureNode.id).position,
      structureNode.position,
    );
    assert.equal(
      screenScale(forwardPrepared)
        * screenScale(reversePrepared),
      1,
    );
  }

  const enteringChild = forward.prepared.find((candidate) => candidate.id === detailChild.id);
  const exitingChild = reverse.active.find((candidate) => candidate.id === detailChild.id);
  const exitingBranchSummary = forward.active.find((candidate) => (
    candidate.id === branchSummary.id
  ));
  const enteringBranchSummary = reverse.prepared.find((candidate) => (
    candidate.id === branchSummary.id
  ));
  assert.deepEqual(enteringChild.position, detailChild.position);
  assert.equal(motion.projectionNodeFadeOnly(enteringChild), true);
  assert.equal(motion.projectionNodeDelay(enteringChild), 0);
  assert.equal(motion.projectionNodeFadeOnly(exitingChild), true);
  assert.equal(motion.projectionNodeDelay(exitingChild), 0);
  assert.equal(motion.projectionNodeFadeOnly(exitingBranchSummary), true);
  assert.equal(motion.projectionNodeDelay(exitingBranchSummary), 0);
  assert.deepEqual(enteringBranchSummary.position, branchSummary.position);
  assert.equal(motion.projectionNodeFadeOnly(enteringBranchSummary), true);
  assert.equal(motion.projectionNodeDelay(enteringBranchSummary), 0);
});

test("Flow detail swaps crossfade sibling flow screens without moving them through summaries", () => {
  const retainedSummary = node(
    "summary-banking",
    { x: 760, y: 80 },
    { width: 220, height: 118 },
    areaMotion,
  );
  const nextRetainedSummary = node(
    retainedSummary.id,
    { x: 820, y: 120 },
    { width: 220, height: 118 },
    areaMotion,
  );
  const previousScreenMotion = metadata({
    motionKey: "screen:previous-root",
    role: "screen",
    representedScreenIds: ["previous-root"],
    areaId: "banking",
    branchId: "previous-flow",
    areaRepresentativeScreenId: "banking-root",
    branchRepresentativeScreenId: "previous-root",
  });
  const nextScreenMotion = metadata({
    motionKey: "screen:next-root",
    role: "screen",
    representedScreenIds: ["next-root"],
    areaId: "banking",
    branchId: "next-flow",
    areaRepresentativeScreenId: "banking-root",
    branchRepresentativeScreenId: "next-root",
  });
  const previousSummaryMotion = metadata({
    motionKey: "summary:previous-flow",
    role: "summary",
    representedScreenIds: ["previous-root"],
    areaId: "banking",
    branchId: "previous-flow",
    representativeScreenId: "previous-root",
    areaRepresentativeScreenId: "banking-root",
    branchRepresentativeScreenId: "previous-root",
  });
  const nextSummaryMotion = metadata({
    motionKey: "summary:next-flow",
    role: "summary",
    representedScreenIds: ["next-root"],
    areaId: "banking",
    branchId: "next-flow",
    representativeScreenId: "next-root",
    areaRepresentativeScreenId: "banking-root",
    branchRepresentativeScreenId: "next-root",
  });
  const previousScreen = node(
    "previous-root",
    { x: 120, y: 220 },
    { width: 184, height: 420 },
    previousScreenMotion,
  );
  const nextScreen = node(
    "next-root",
    { x: 420, y: 220 },
    { width: 184, height: 420 },
    nextScreenMotion,
  );
  const previousFlowSummary = node(
    "summary-previous-flow",
    { x: 820, y: 260 },
    { width: 220, height: 118 },
    previousSummaryMotion,
  );
  const nextFlowSummary = node(
    "summary-next-flow",
    { x: 820, y: 440 },
    { width: 220, height: 118 },
    nextSummaryMotion,
  );

  const frames = motion.projectionTransitionFrames(
    [nextRetainedSummary, nextScreen, previousFlowSummary],
    [retainedSummary, previousScreen, nextFlowSummary],
    { fromLevel: "detail", toLevel: "detail" },
  );
  const preparedNextScreen = frames.prepared.find((candidate) => candidate.id === nextScreen.id);
  const activePreviousScreen = frames.active.find((candidate) => (
    candidate.id === previousScreen.id
  ));
  const preparedPreviousSummary = frames.prepared.find((candidate) => (
    candidate.id === previousFlowSummary.id
  ));
  const activeNextSummary = frames.active.find((candidate) => (
    candidate.id === nextFlowSummary.id
  ));
  const preparedRetainedSummary = frames.prepared.find((candidate) => (
    candidate.id === retainedSummary.id
  ));

  assert.deepEqual(preparedNextScreen.position, nextScreen.position);
  assert.equal(motion.projectionNodeFadeOnly(preparedNextScreen), true);
  assert.equal(motion.projectionNodeDelay(preparedNextScreen), 0);
  assert.deepEqual(activePreviousScreen.position, previousScreen.position);
  assert.equal(motion.projectionNodeFadeOnly(activePreviousScreen), true);
  assert.equal(motion.projectionNodeDelay(activePreviousScreen), 0);
  assert.deepEqual(preparedPreviousSummary.position, previousFlowSummary.position);
  assert.equal(motion.projectionNodeFadeOnly(preparedPreviousSummary), true);
  assert.equal(motion.projectionNodeDelay(preparedPreviousSummary), 0);
  assert.deepEqual(activeNextSummary.position, nextFlowSummary.position);
  assert.equal(motion.projectionNodeFadeOnly(activeNextSummary), true);
  assert.equal(motion.projectionNodeDelay(activeNextSummary), 0);
  assert.deepEqual(preparedRetainedSummary.position, retainedSummary.position);
  assert.equal(motion.projectionNodeFadeOnly(preparedRetainedSummary), false);
  assert.deepEqual(
    frames.active.find((candidate) => candidate.id === retainedSummary.id).position,
    nextRetainedSummary.position,
  );
});

test("collapse camera rejects a selected fade-only screen and follows the shared summary", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const nextSummary = node("summary-banking", { x: 700, y: 80 }, { width: 220, height: 118 }, areaMotion);
  const selected = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);
  const frames = motion.projectionTransitionFrames([nextSummary], [summary, selected], {
    fromLevel: "structure",
    toLevel: "overview",
  });

  const pair = motion.selectProjectionMotionAnchor(
    frames.source,
    [nextSummary],
    frames.active,
    selected.id,
    center(selected),
  );
  assert.equal(pair.from.id, summary.id);
  assert.equal(pair.to.id, nextSummary.id);
  assert.equal(motion.projectionAnchorActor(pair, frames.source, [nextSummary]).id, summary.id);
});

test("a rapid reversal revives a fade-only screen as a normal shared actor", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 280 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);
  const collapse = motion.projectionTransitionFrames([summary], [summary, root, child], {
    fromLevel: "structure",
    toLevel: "overview",
  });
  const reverse = motion.projectionTransitionFrames([summary, root, child], collapse.active, {
    fromLevel: "overview",
    toLevel: "structure",
  });
  for (const screen of [root, child]) {
    const prepared = reverse.prepared.find((candidate) => candidate.id === screen.id);
    const active = reverse.active.find((candidate) => candidate.id === screen.id);
    assert.equal(motion.projectionNodeFadeOnly(prepared), false);
    assert.equal(motion.projectionNodeFadeOnly(active), false);
    assert.equal(motion.projectionNodeDelay(prepared), 0);
    assert.equal(motion.projectionNodeDelay(active), 0);
  }
});

test("direct overview-detail drill-down preserves spatial expansion for every represented screen", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 280 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);

  const frames = motion.projectionTransitionFrames([root, child], [summary], {
    fromLevel: "overview",
    toLevel: "detail",
  });
  for (const candidate of [root, child]) {
    const prepared = frames.prepared.find((entry) => entry.id === candidate.id);
    assert.deepEqual(center(prepared), center(summary));
    assert.equal(motion.projectionNodeFadeOnly(prepared), false);
  }
});

test("unknown hierarchy defaults to one representative instead of assuming a many-object morph", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 280 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);

  const frames = motion.projectionTransitionFrames([root, child], [summary]);
  const preparedRoot = frames.prepared.find((candidate) => candidate.id === root.id);
  const preparedChild = frames.prepared.find((candidate) => candidate.id === child.id);
  assert.deepEqual(center(preparedRoot), center(summary));
  assert.equal(motion.projectionNodeFadeOnly(preparedRoot), false);
  assert.deepEqual(preparedChild.position, child.position);
  assert.equal(motion.projectionNodeFadeOnly(preparedChild), true);
});

test("missing semantic metadata falls back to an in-place crossfade", () => {
  const current = node("legacy-a", { x: 10, y: 20 }, { width: 80, height: 160 }, undefined);
  const next = node("legacy-b", { x: 900, y: 700 }, { width: 80, height: 160 }, undefined);

  const frames = motion.projectionTransitionFrames([next], [current], {
    fromLevel: "structure",
    toLevel: "detail",
  });
  const entering = frames.prepared.find((candidate) => candidate.id === next.id);
  const leaving = frames.active.find((candidate) => candidate.id === current.id);
  assert.deepEqual(entering.position, next.position);
  assert.deepEqual(leaving.position, current.position);
  assert.equal(motion.projectionNodeFadeOnly(entering), true);
  assert.equal(motion.projectionNodeFadeOnly(leaving), true);
});

test("collapses branch members into the next area card and removes stale exit generations", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 280 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 280 }, { width: 184, height: 420 }, childMotion);
  const stale = node(
    "stale-screen",
    { x: 900, y: 900 },
    { width: 184, height: 420 },
    metadata({
      motionKey: "screen:stale-screen",
      role: "screen",
      representedScreenIds: ["stale-screen"],
      areaId: "stale",
      areaRepresentativeScreenId: "stale-screen",
    }),
    "canvas-node-exit",
  );

  const frames = motion.projectionTransitionFrames([summary], [summary, root, child, stale], {
    fromLevel: "detail",
    toLevel: "overview",
  });
  for (const id of [root.id, child.id]) {
    const pending = frames.prepared.find((candidate) => candidate.id === id);
    assert.match(pending.className, /canvas-node-moving/);
    assert.equal(motion.projectionNodePendingExit(pending), true);
    const exiting = frames.active.find((candidate) => candidate.id === id);
    assert.deepEqual(center(exiting), center(summary));
    assert.match(exiting.className, /canvas-node-exit/);
  }
  assert.equal(frames.prepared.some((candidate) => candidate.id === stale.id), false);
  assert.equal(frames.active.some((candidate) => candidate.id === stale.id), false);
  assert.equal(new Set(frames.active.map((candidate) => candidate.id)).size, frames.active.length);
});

test("collapses a hidden selected screen into its representing summary and tracks that screen", () => {
  const summary = node("summary-banking", { x: 40, y: 80 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 320, y: 120 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 620, y: 120 }, { width: 184, height: 420 }, childMotion);
  const nextRoot = node("banking-root", { x: 360, y: 160 }, { width: 184, height: 420 }, rootMotion);

  const frames = motion.projectionTransitionFrames([summary, nextRoot], [root, child], {
    fromLevel: "detail",
    toLevel: "overview",
  });
  const exitingChild = frames.active.find((candidate) => candidate.id === child.id);
  assert.deepEqual(center(exitingChild), center(summary));

  const pair = motion.selectProjectionAnchor(
    frames.source,
    [summary, nextRoot],
    child.id,
    center(child),
  );
  assert.equal(pair.from.id, child.id);
  assert.equal(pair.to.id, summary.id);
  assert.equal(
    motion.projectionAnchorActor(pair, frames.source, [summary, nextRoot]).id,
    child.id,
  );
});

test("tracks the selected entering child when its area summary disappears", () => {
  const summary = node("summary-banking", { x: 40, y: 80 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 320, y: 120 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 620, y: 120 }, { width: 184, height: 420 }, childMotion);
  const next = [root, child];
  const frames = motion.projectionTransitionFrames(next, [summary], {
    fromLevel: "overview",
    toLevel: "detail",
  });
  const pair = motion.selectProjectionAnchor(
    frames.source,
    next,
    child.id,
    center(summary),
  );
  assert.equal(pair.from.id, summary.id);
  assert.equal(pair.to.id, child.id);
  assert.equal(motion.projectionAnchorActor(pair, frames.source, next).id, child.id);
  assert.deepEqual(
    center(frames.prepared.find((candidate) => candidate.id === child.id)),
    center(summary),
  );
  assert.deepEqual(
    center(frames.active.find((candidate) => candidate.id === child.id)),
    center(child),
  );
});

test("keeps rapid prepared retargets bounded to the current and next generation", () => {
  const motions = ["a", "b", "c", "d"].map((id) => metadata({
    motionKey: `screen:${id}`,
    role: "screen",
    representedScreenIds: [id],
    areaId: id,
    areaRepresentativeScreenId: id,
  }));
  const nodes = motions.map((entry, index) => node(
    entry.representedScreenIds[0],
    { x: index * 100, y: index * 50 },
    { width: 40, height: 80 },
    entry,
  ));

  const first = motion.projectionTransitionFrames([nodes[1]], [nodes[0]]);
  const second = motion.projectionTransitionFrames([nodes[2]], first.prepared);
  const third = motion.projectionTransitionFrames([nodes[3]], second.prepared);
  assert.deepEqual(first.prepared.map((candidate) => candidate.id).sort(), ["a", "b"]);
  assert.deepEqual(second.prepared.map((candidate) => candidate.id).sort(), ["b", "c"]);
  assert.deepEqual(third.prepared.map((candidate) => candidate.id).sort(), ["c", "d"]);
  assert.equal(third.prepared.filter((candidate) => (
    motion.projectionNodePendingExit(candidate)
  )).length, 1);
});

test("fits incoming bounds while preserving the semantic anchor screen position", () => {
  const summary = node("summary-banking", { x: 100, y: 200 }, { width: 220, height: 118 }, areaMotion);
  const root = node("banking-root", { x: 420, y: 180 }, { width: 184, height: 420 }, rootMotion);
  const child = node("banking-child", { x: 680, y: 180 }, { width: 184, height: 420 }, childMotion);
  const startViewport = { x: 200, y: 100, zoom: 1 };
  const plan = motion.projectionCameraPlan({
    current: [summary],
    next: [root, child],
    startViewport,
    canvasWidth: 1200,
    canvasHeight: 900,
    padding: 0.1,
    minZoom: 0.02,
    maxZoom: 1,
    preferredScreenId: "banking-root",
  });
  assert.ok(plan?.anchor);
  assert.ok(Math.abs(plan.anchor.fromScreen.x - plan.anchor.toScreen.x) < 1e-9);
  assert.ok(Math.abs(plan.anchor.fromScreen.y - plan.anchor.toScreen.y) < 1e-9);
  assert.equal(
    plan.anchor.toWorld.x * plan.target.zoom + plan.target.x,
    plan.anchor.toScreen.x,
  );
  assert.equal(
    plan.anchor.toWorld.y * plan.target.zoom + plan.target.y,
    plan.anchor.toScreen.y,
  );
});

test("direct projection fit uses the same numeric padding scale as React Flow", () => {
  const target = node("area-grid", { x: 100, y: 200 }, { width: 800, height: 600 }, areaMotion);
  const plan = motion.projectionCameraPlan({
    current: [],
    next: [target],
    startViewport: { x: 0, y: 0, zoom: 1 },
    canvasWidth: 1200,
    canvasHeight: 900,
    padding: 0.2,
    minZoom: 0.02,
    maxZoom: 2,
    anchorPair: null,
  });
  assert.equal(plan?.target.zoom, 1.25);
  assert.deepEqual(plan?.target, { x: -25, y: -175, zoom: 1.25 });
});

test("projection easing is symmetric, monotonic, and matches both endpoints", () => {
  assert.equal(motion.projectionEasing(0), 0);
  assert.equal(motion.projectionEasing(1), 1);
  assert.ok(Math.abs(motion.projectionEasing(0.5) - 0.5) < 0.000001);
  const samples = Array.from({ length: 21 }, (_, index) => motion.projectionEasing(index / 20));
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index] >= samples[index - 1]);
  }
  for (let index = 0; index < samples.length; index += 1) {
    assert.ok(Math.abs(samples[index] + samples.at(-index - 1) - 1) < 0.000001);
  }
});
