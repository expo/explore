import { toast } from "sonner";

type ScreenPathTextProps = {
  path: string;
  screenTitle: string;
  className?: string;
  /** Use a native button when the path is not already inside an interactive canvas node. */
  asButton?: boolean;
};

async function copyDeepLink(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast.success("Copied deep link");
  } catch {
    toast.error("Could not copy deep link");
  }
}

export function ScreenPathText(props: ScreenPathTextProps) {
  const label = `Copy deep link ${props.path}`;
  const className = `screen-path-text${props.className ? ` ${props.className}` : ""}`;

  if (props.asButton) {
    return (
      <button
        type="button"
        className={className}
        aria-label={label}
        title={`${props.screenTitle} · ${label}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void copyDeepLink(props.path);
        }}>
        {props.path}
      </button>
    );
  }

  return (
    <span
      className={className}
      role="link"
      tabIndex={0}
      aria-label={label}
      title={`${props.screenTitle} · ${label}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void copyDeepLink(props.path);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        void copyDeepLink(props.path);
      }}>
      {props.path}
    </span>
  );
}
