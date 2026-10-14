/**
 * The one agent-device version Explore runs. The local CLI (`package.json`), the EAS Simulator
 * controller (`--package-version`), the daemon health check, and the screenshot diff tool must
 * all be this version; each caller checks it by exact equality.
 */
export const AGENT_DEVICE_VERSION = "0.21.15";
