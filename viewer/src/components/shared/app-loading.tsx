import { ExpoLogo } from "./expo-logo";

export function AppLoading({ label }: { label: string }) {
  return <main className="app-loading" aria-label={label} aria-busy="true">
    <div className="app-loading-logo" aria-hidden="true">
      <ExpoLogo mark />
      <div className="app-loading-logo-fill"><ExpoLogo mark /></div>
    </div>
  </main>;
}
