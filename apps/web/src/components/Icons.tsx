import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 18, viewBox = "0 0 24 24", className, children }: IconProps & { viewBox?: string; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** The Selio logo: the purple "S" on a dark glass tile (public/logo-192.png, derived from logo.png). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <img
      className="logo-mark"
      src={`${import.meta.env.BASE_URL}logo-192.png`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
    />
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Svg>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
    </Svg>
  );
}

export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12l5 5 9-10" />
    </Svg>
  );
}

export function Cross(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

export function Lock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function FlowArrow() {
  return (
    <svg
      className="flow-arrow"
      width="44"
      height="24"
      viewBox="0 0 44 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12h38" />
      <path d="M32 5l8 7-8 7" />
    </svg>
  );
}

export function PathIcon({ d, size = 22 }: { d: string; size?: number }) {
  return (
    <Svg size={size}>
      <path d={d} />
    </Svg>
  );
}
