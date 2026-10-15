import { homedir } from "node:os";
import { join } from "node:path";

/** Where Explore keeps what outlives a run on this machine: `$EXPLORE_CACHE_DIR`, else `$XDG_CACHE_HOME/expo-explore`, else `~/.cache/expo-explore`. */
export function exploreCacheRoot(environment: NodeJS.ProcessEnv): string {
  return environment.EXPLORE_CACHE_DIR || join(environment.XDG_CACHE_HOME || join(environment.HOME || homedir(), ".cache"), "expo-explore");
}
