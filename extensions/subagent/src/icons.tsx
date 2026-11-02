/**
 * The few marks the extension draws, as plain SVG in the colour of the text around them: it brings no icon package
 * of its own.
 */
type Props = { "aria-hidden"?: boolean; className?: string };

const svg = { viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Its mark in Settings' list and on the chat's header: one agent handing on to two. */
export function AgentsIcon(props: Props) {
  return (
    <svg {...svg} aria-hidden="true" className={props.className}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M9 6h6M8.1 8.1l7.8 7.8" />
    </svg>
  );
}

/** A subagent: a small robot's head. */
export function AgentIcon(props: Props) {
  return (
    <svg {...svg} aria-hidden="true" className={props.className}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M9 13v2M15 13v2M2 14h2M20 14h2" />
    </svg>
  );
}

/** Stop: a square, filled. */
export function StopIcon(props: Props) {
  return (
    <svg {...svg} aria-hidden="true" className={props.className}>
      <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" />
    </svg>
  );
}

/** Send: an arrow up. */
export function SendIcon(props: Props) {
  return (
    <svg {...svg} aria-hidden="true" className={props.className}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** Open elsewhere: an arrow out of a box. */
export function OpenIcon(props: Props) {
  return (
    <svg {...svg} aria-hidden="true" className={props.className}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
