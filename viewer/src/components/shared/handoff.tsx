import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { useModalDialog } from "../../hooks/use-modal-dialog";
import { ClaudeIcon, OpenAIIcon } from "./agent-icons";
import { formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { claudeDeepLink, codexDeepLink, handoffPrompt, type HandoffInput, type HandoffView } from "../../utils/handoff";
import { PhoneSheet } from "../phone/phone-chrome";
import { Tooltip } from "./tooltip";
import "./handoff.css";

const TITLE = "Hand off to your AI agent";
const DESCRIPTION = "Paste this into Claude Code, Codex, or any agent that can fetch URLs. The link gives it everything in this report: screens, diffs and screenshots.";

/** An icon: beside Search in the bottom toolbar on desktop (named by a tooltip), in the app bar on a phone, and in the phone Compare header. */
export function HandoffButton(props: { className?: string; tooltip?: boolean; onOpen: () => void }) {
  const button = (
    <button type="button" className={`${props.className ?? "toolbar-button"} handoff-icon-button`} aria-label="Hand off to AI" onClick={props.onOpen}>
      <Sparkles aria-hidden="true" />
    </button>
  );
  return props.tooltip ? <Tooltip label="Hand off to AI" shortcut={formatShortcut(SHORTCUTS.app.handoff)} placement="top">{button}</Tooltip> : button;
}

function HandoffContent(props: { input: HandoffInput; view: HandoffView; phone: boolean }) {
  const [scoped, setScoped] = useState(true);
  const [copied, setCopied] = useState(false);
  const prompt = handoffPrompt(props.input, scoped ? props.view : undefined);
  const where = [props.view.screen, props.view.view, props.view.platform, props.view.appearance].filter(Boolean).join(" · ");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      toast.success("Copied prompt");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy the prompt");
    }
  };
  return (
    <div className="handoff-content">
      <p className="handoff-description">{DESCRIPTION}</p>
      <label className="handoff-scope">
        <span className="handoff-scope-text">
          <span>Start from what I'm viewing</span>
          <small>{where}</small>
        </span>
        <input type="checkbox" role="switch" className="handoff-switch" checked={scoped}
          onChange={(event) => setScoped(event.target.checked)} />
      </label>
      <pre className="handoff-prompt" tabIndex={0} aria-label="Prompt">{prompt}</pre>
      <div className="handoff-actions">
        {/* The deep links open desktop apps; a phone has neither. */}
        {props.phone ? null : (
          <>
            <a className="handoff-action" href={claudeDeepLink(prompt)}><ClaudeIcon />Claude</a>
            <a className="handoff-action" href={codexDeepLink(prompt)}><OpenAIIcon />Codex</a>
          </>
        )}
        <button type="button" className="handoff-action primary" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
    </div>
  );
}

function HandoffModal(props: { input: HandoffInput; view: HandoffView; onClose: () => void }) {
  const dialogRef = useModalDialog(true, props.onClose);
  return createPortal(
    <div className="handoff-scrim" onPointerDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <div ref={dialogRef} className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <header className="handoff-header">
          <Sparkles aria-hidden="true" />
          <h2 id="handoff-title">{TITLE}</h2>
          <button type="button" className="handoff-close" aria-label="Close" onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <HandoffContent input={props.input} view={props.view} phone={false} />
      </div>
    </div>,
    document.body,
  );
}

/** The handoff as a modal on desktop and a sheet in the phone layout. */
export function HandoffDialog(props: { open: boolean; phone: boolean; input: HandoffInput; view: HandoffView; onClose: () => void }) {
  if (props.phone) {
    return (
      <PhoneSheet title="Hand off to AI" open={props.open} onClose={props.onClose} fullScreen>
        <HandoffContent input={props.input} view={props.view} phone />
      </PhoneSheet>
    );
  }
  return props.open ? <HandoffModal input={props.input} view={props.view} onClose={props.onClose} /> : null;
}
