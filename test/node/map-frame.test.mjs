import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { mapFrame, MAP_SCREEN_WIDTH, MAP_SCREEN_HEIGHT } = await tsImport("../../viewer/src/utils/map-frame.ts", import.meta.url);
const { typicalScreenshotSize } = await tsImport("../../viewer/src/utils/screen-images.ts", import.meta.url);

const size = (imageWidth, imageHeight) => ({ imageWidth, imageHeight });

test("phone screenshots keep the map's default card", () => {
  for (const phone of [size(402, 874), size(1206, 2622), size(720, 1600), undefined]) {
    const frame = mapFrame(phone);
    assert.equal(frame.width, MAP_SCREEN_WIDTH);
    assert.equal(frame.height, MAP_SCREEN_HEIGHT);
  }
  assert.deepEqual(mapFrame(size(720, 1600)).screen, { width: 720, height: 1600 }, "a missing screenshot is framed like the run's");
});

test("a wider screen gets a card in its own shape with about the same screen area", () => {
  // iPhone Duo screenshots are 1398 × 2034 pixels.
  const duo = mapFrame(size(1398, 2034));
  const slotHeight = duo.height - 34;
  assert.ok(Math.abs(duo.width / slotHeight - 1398 / 2034) < 0.01, JSON.stringify(duo));
  const phoneArea = mapFrame(size(402, 874));
  const area = duo.width * slotHeight, defaultArea = (phoneArea.height - 34) ** 2 * (9 / 19.5);
  assert.ok(Math.abs(area / defaultArea - 1) < 0.02, `${area} vs ${defaultArea}`);
  assert.ok(duo.width > MAP_SCREEN_WIDTH && duo.height < MAP_SCREEN_HEIGHT);
});

test("a run's screenshot shape is its median one, and unknown sizes do not count", () => {
  const duo = size(1398, 2034);
  assert.deepEqual(typicalScreenshotSize([duo, undefined, duo, size(1398, 3000), duo]), duo);
  assert.equal(typicalScreenshotSize([undefined, undefined]), undefined);
});
