// One module graph for Explore's binary run and the controller's failure parser: a typed refusal is recognised by the same
// parser instance that produced it, so a fake agent-device that fails with a reason must build its failure here.
export { runBinaryExploration } from "../../src/binary/run.js";
export { commandOutcome } from "../../src/capture/controller.js";
