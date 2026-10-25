import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type WheelEvent } from "react";

/**
 * A neighbour's size and opacity by its distance from the frame in the middle. The last, invisible, place is where a
 * frame waits to come in, so a swipe or a step fades it in rather than popping it.
 */
const SCALES = [1, 0.74, 0.54, 0.4, 0.3];
const OPACITIES = [1, 0.9, 0.6, 0.3, 0];
const GAP = 32;
/** A swipe has ended once its wheel events (and the trackpad's momentum after it) stop for this long. */
const SWIPE_END_MS = 100;
/**
 * At the end of a swipe the strip settles on the next frame in its direction once it has moved this far towards it,
 * so one wheel notch steps a frame and a twitch springs back.
 */
const SWIPE_COMMIT = 0.2;
/** How far a finger moves before a touch is a swipe rather than a tap. */
const TAP_SLOP_PX = 8;
/** How far ahead a flick's speed carries the strip when the finger lifts: its velocity times this. */
const FLICK_MS = 160;
/**
 * How long the strip takes to settle after a gesture: longer the further it has left to go, so that a short way home
 * is not crossed at the speed of a whole step and a long one does not snap.
 */
const settleMs = (distance: number) => Math.round(260 + 260 * Math.min(1, distance));

export type FilmstripFrame = {
  /** Its place in the middle, nearer or further: content that loads lazily waits until it is near. */
  middle: boolean;
  distance: number;
};

export type FilmstripProps = {
  /** The frames, in order: each with its width over its height. */
  items: readonly { id: string; aspect: number }[];
  /** The frame in the middle. */
  focusedId: string;
  /** Above the stage: what the middle frame is. */
  header: ReactNode;
  ariaLabel: string;
  /** The element id a frame takes, which a page's arrow keys focus by. */
  frameId?: (id: string) => string;
  /** The data attribute that carries a frame's id: Screens' frames are found by `data-screen-id`. */
  idAttribute?: `data-${string}`;
  /** Classes a frame takes beside its own, such as its status. */
  frameClass?: (id: string) => string | undefined;
  /** A frame's accessible name. */
  label: (id: string) => string;
  /** What a frame shows. */
  content: (id: string, frame: FilmstripFrame) => ReactNode;
  /** Whether the frame is the one selected, for its button's pressed state. */
  selected?: (id: string) => boolean;
  /** Brings a frame to the middle; `replace` asks a caller that keeps history to keep it out. */
  onPick: (id: string, options?: { replace?: boolean }) => void;
  /** A click on the middle frame; without it the middle frame does nothing on a click. */
  onOpen?: (id: string) => void;
  /** The phone layout: the middle frame takes most of the width, and a finger swipes the strip. */
  phone?: boolean | undefined;
};

/** The stage's size, which the frames are fitted to. */
function useSize(): [(element: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

/**
 * Frames one at a time: the focused one large in the middle, the ones before and after it smaller and fainter the
 * further they are, in order. A swipe (trackpad, wheel or finger) moves the strip with it and settles on a frame; a
 * click on a neighbour brings it to the middle.
 */
export function Filmstrip(props: FilmstripProps) {
  const [stageRef, stage] = useSize();
  const order = props.items.map(item => item.id);
  const aspects = new Map(props.items.map(item => [item.id, item.aspect]));
  const at = order.indexOf(props.focusedId);
  // While a swipe lasts, the strip sits at a fractional position in `order`, following the gesture.
  const [swipe, setSwipe] = useState<{ position: number; direction: number } | null>(null);
  // Once the gesture lets go, the strip eases the rest of the way on a timing of its own (settleMs).
  const [settling, setSettling] = useState<number | null>(null);
  const settled = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The swipe's position as of the last wheel event, which can arrive before the render that shows the one before it.
  const live = useRef<number | null>(null);
  // A finger on the strip: where it went down, the strip's position then, and its latest speed in px/ms.
  const touch = useRef<{ id: number; x: number; from: number; lastX: number; lastAt: number; velocity: number; moved: boolean } | null>(null);
  // A swipe ends with the finger lifting over a frame; the click that follows is not a tap on it.
  const swallowClick = useRef(false);
  const swipeEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(swipeEnd.current); clearTimeout(settled.current); }, []);
  // The gesture under way: the frames it has put in the middle, the last of them, and whether it has added its one
  // history entry. A frame put in the middle by anything else (an arrow key, a list, a click) ends it.
  const gesture = useRef<{ shown: string; ids: Set<string>; pushed: boolean; start: number } | null>(null);
  const focusedNow = useRef(props.focusedId);
  useEffect(() => { focusedNow.current = props.focusedId; });

  if (at < 0) return null;

  // Every frame is laid out as the middle one would be, filling the stage's height short of growing wider than half
  // the stage (on a phone, most of it, with the neighbours peeking in at the sides), so a landscape frame beside
  // portrait ones is as wide as it may be rather than as tall; then it is scaled down around its centre, and the centres
  // are spaced so the scaled frames sit a gap apart, the gap shrinking with them.
  const frameSize = (id: string) => {
    const aspect = aspects.get(id) ?? 1;
    const height = Math.max(0, Math.min(stage.height - 16, (stage.width * (props.phone ? 0.7 : 0.5)) / aspect));
    return { width: height * aspect, height };
  };
  // Where each frame sits with the frame at `centre` in the middle: its distance and its centre's offset.
  const layout = (centre: number) => {
    const placed = new Map<string, { distance: number; x: number }>();
    const middle = order[centre];
    if (middle === undefined) return placed;
    placed.set(middle, { distance: 0, x: 0 });
    for (const direction of [-1, 1]) {
      let edge = frameSize(middle).width / 2;
      for (let distance = 1; distance < SCALES.length; distance++) {
        const id = order[centre + direction * distance];
        if (id === undefined) break;
        const scaled = frameSize(id).width * SCALES[distance]!;
        const x = edge + GAP * SCALES[distance]! + scaled / 2;
        placed.set(id, { distance, x: direction * x });
        edge = x + scaled / 2;
      }
    }
    return placed;
  };
  // A swipe someone else's step overtook (an arrow key, a click) no longer places the strip.
  const swiping = swipe !== null && Math.round(swipe.position) === at;
  const position = swiping ? swipe.position : at;
  const base = Math.floor(position), fraction = position - base;
  const from = layout(base), to = fraction > 0 ? layout(base + 1) : from;
  const lerp = (a: number, b: number) => a + (b - a) * fraction;
  const last = SCALES.length - 1;
  // In the strip's order, so the frames' elements keep their order in the page as the middle changes: React moves an
  // element that changes place among its siblings, and a moved element jumps instead of easing to where it goes.
  const placeOf = new Map(order.map((id, place) => [id, place]));
  const frames = [...new Set([...from.keys(), ...to.keys()])].sort((a, b) => placeOf.get(a)! - placeOf.get(b)!).map(id => {
    const a = from.get(id), b = to.get(id);
    // A frame in only one of the two places is coming in or going out at the invisible end.
    const distance = lerp(a?.distance ?? last, b?.distance ?? last);
    const x = lerp(a?.x ?? b!.x, b?.x ?? a!.x);
    const scale = lerp(SCALES[a?.distance ?? last]!, SCALES[b?.distance ?? last]!);
    const opacity = lerp(OPACITIES[a?.distance ?? last]!, OPACITIES[b?.distance ?? last]!);
    return { id, distance, x, scale, opacity, ...frameSize(id) };
  });
  // The frames' gap at rest, which one frame of swipe travels.
  const pitch = Math.abs(layout(at).get(order[at + 1] ?? order[at - 1] ?? "")?.x ?? frameSize(props.focusedId).width) || 1;

  const clamp = (value: number) => Math.max(0, Math.min(order.length - 1, value));
  const abandon = () => { clearTimeout(swipeEnd.current); gesture.current = null; live.current = null; };
  const overtaken = () => !gesture.current || !gesture.current.ids.has(focusedNow.current);
  // Where a gesture starts: where the one under way has the strip, or the frame in the middle for a new one.
  const begin = (): number => {
    if (!overtaken() && live.current !== null) return live.current;
    abandon();
    const index = order.indexOf(focusedNow.current);
    const start = index < 0 ? at : index;
    gesture.current = { shown: focusedNow.current, ids: new Set([focusedNow.current]), pushed: false, start };
    return start;
  };
  // Puts a frame in the middle for the gesture: its first pick is one step back in the history, the rest replace it.
  const show = (id: string) => {
    const current = gesture.current;
    if (!current || id === current.shown) return;
    current.shown = id; current.ids.add(id);
    props.onPick(id, current.pushed ? { replace: true } : undefined);
    current.pushed = true;
  };
  // Puts the strip at `next` while a gesture lasts; the middle frame, and with it the header, follows the swipe as it
  // passes halfway.
  const moveTo = (next: number, direction: number) => {
    live.current = next;
    setSwipe({ position: next, direction });
    show(order[Math.round(next)]!);
  };
  // When the gesture ends, the strip settles on the next frame in its direction once it is SWIPE_COMMIT of the way
  // there; `next` may be ahead of where the strip is, carried on by a flick.
  const settle = (next: number, direction: number) => {
    if (overtaken()) { abandon(); setSwipe(null); return; }
    const index = clamp(direction > 0 ? Math.floor(next + 1 - SWIPE_COMMIT) : direction < 0 ? Math.ceil(next - 1 + SWIPE_COMMIT) : Math.round(next));
    show(order[index]!);
    gesture.current = null;
    const ms = settleMs(Math.abs(index - (live.current ?? next)));
    clearTimeout(settled.current);
    setSettling(ms);
    settled.current = setTimeout(() => setSettling(null), ms);
    live.current = null;
    setSwipe(null);
  };

  // A swipe along either axis moves the strip with it, so a mouse wheel works as well as a trackpad; it has ended when
  // its events stop.
  const onWheel = (event: WheelEvent) => {
    // A pinch arrives as a wheel with Control held; it zooms the page, not the strip.
    if (event.ctrlKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const pixels = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * stage.width : delta;
    if (!pixels) return;
    const next = clamp(begin() + pixels / pitch);
    // The way the whole swipe went, not its last event: momentum's last 1px back must not turn a swipe around.
    const direction = Math.sign(next - gesture.current!.start) || Math.sign(pixels);
    moveTo(next, direction);
    clearTimeout(swipeEnd.current);
    swipeEnd.current = setTimeout(() => settle(next, direction), SWIPE_END_MS);
  };

  // A finger drags the strip under it; on lifting, a flick carries it on by its speed before it settles. A mouse
  // keeps its clicks and wheel.
  const onPointerDown = (event: PointerEvent) => {
    // A browser that sent no click after the last swipe must not have this press's click swallowed, by finger or mouse.
    swallowClick.current = false;
    // A touch whose end never reached the strip (it slid off before it moved enough to be held) gives way to this one.
    if (event.pointerType === "mouse" || touch.current?.id === event.pointerId) return;
    touch.current = { id: event.pointerId, x: event.clientX, from: begin(), lastX: event.clientX, lastAt: event.timeStamp, velocity: 0, moved: false };
  };
  const onPointerMove = (event: PointerEvent) => {
    const current = touch.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    if (!current.moved && Math.abs(dx) < TAP_SLOP_PX) return;
    // A wheel swipe's settle waits until the finger takes over; a tap leaves it to settle.
    if (!current.moved) { current.moved = true; clearTimeout(swipeEnd.current); event.currentTarget.setPointerCapture(event.pointerId); }
    const elapsed = event.timeStamp - current.lastAt;
    if (elapsed > 0) current.velocity = (event.clientX - current.lastX) / elapsed;
    current.lastX = event.clientX; current.lastAt = event.timeStamp;
    moveTo(clamp(current.from - dx / pitch), -Math.sign(dx));
  };
  const onPointerEnd = (event: PointerEvent) => {
    const current = touch.current;
    if (!current || current.id !== event.pointerId) return;
    touch.current = null;
    if (!current.moved) return;
    swallowClick.current = true;
    // A finger that stopped before lifting carries nothing on.
    const velocity = event.timeStamp - current.lastAt > 80 ? 0 : current.velocity;
    const next = clamp((live.current ?? position) - (velocity * FLICK_MS) / pitch);
    settle(next, velocity ? -Math.sign(velocity) : -Math.sign(event.clientX - current.x));
  };

  return (
    <section className={`screens-strip${props.phone ? " phone" : ""}${props.onOpen ? "" : " static-middle"}`} aria-label={props.ariaLabel} onWheel={onWheel}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      onClickCapture={(event) => { if (swallowClick.current) { swallowClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
      {props.header}
      <div ref={stageRef} className={`screens-strip-stage${swiping ? " swiping" : settling ? " settling" : ""}`}
        style={settling ? ({ "--strip-settle-ms": `${settling}ms` } as CSSProperties) : undefined}>
        {stage.width > 0 ? frames.map(({ id, distance, x, scale, opacity, width, height }) => {
          const middle = id === props.focusedId;
          const hidden = opacity === 0;
          const extra = props.frameClass?.(id);
          const label = props.label(id);
          return (
            <div key={id} {...(props.frameId ? { id: props.frameId(id) } : {})} {...{ [props.idAttribute ?? "data-frame-id"]: id }}
              className={`screens-strip-frame${middle ? " focused" : ""}${extra ? ` ${extra}` : ""}`}
              style={{
                width,
                height,
                opacity,
                zIndex: Math.round((SCALES.length - distance) * 10),
                transform: `translate(-50%, -50%) translateX(${x}px) scale(${scale})`,
              }}>
              {/* Only the middle frame is in the tab order: the arrows step the strip, and focus on a neighbour the stage
                  clips would scroll it off its centre. */}
              <button type="button" className="screens-strip-target" aria-label={label} title={middle ? undefined : label}
                tabIndex={middle ? undefined : -1} aria-hidden={hidden || undefined} disabled={hidden}
                aria-pressed={props.selected ? props.selected(id) : undefined} aria-current={middle ? "true" : undefined}
                onClick={() => (middle ? props.onOpen?.(id) : props.onPick(id))}>
                {props.content(id, { middle, distance })}
              </button>
            </div>
          );
        }) : null}
      </div>
    </section>
  );
}
