import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import { App } from "./app";
import { TooltipProvider } from "./components/shared/tooltip";
import { trackUiScale } from "./utils/ui-scale";
import "./styles.css";

// Resolve the saved theme before React starts so the first paint uses it.
const initialTheme = (() => {
  try {
    const saved = localStorage.getItem("expo-explore:theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch { /* Storage is optional in private browsing. */ }
  // Auto: the system's scheme, until the toggle picks Dark or Light.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
})();
document.documentElement.dataset.theme = initialTheme;
document.documentElement.style.colorScheme = initialTheme;
trackUiScale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
