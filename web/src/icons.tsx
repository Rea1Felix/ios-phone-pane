import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...rest }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="6" y="2.5" width="12" height="19" rx="2.75" />
      <line x1="10" y1="5.5" x2="14" y2="5.5" />
      <line x1="11" y1="18.5" x2="13" y2="18.5" />
    </IconBase>
  );
}

export function PowerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v8" />
      <path d="M6.8 6.8a7.5 7.5 0 1 0 10.4 0" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </IconBase>
  );
}

export function StreamIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z" />
    </IconBase>
  );
}

export function PollIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 5v14M16 5v14M3 9.5h5M16 9.5h5M3 14.5h5M16 14.5h5" />
    </IconBase>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.5 10.75 12 3.75l8.5 7" />
      <path d="M6 9.25V19a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V9.25" />
    </IconBase>
  );
}

export function MoonSunIcon({ isDark, ...props }: IconProps & { isDark?: boolean }) {
  if (isDark) {
    return (
      <IconBase {...props}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2M12 19.5v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2.5 12h2M19.5 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </IconBase>
    );
  }
  return (
    <IconBase {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a7.5 7.5 0 1 0 10.5 10.5Z" />
    </IconBase>
  );
}

export function ReleaseControlIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7.5a4 4 0 0 1 7.6-1.7" />
    </IconBase>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.25" />
      <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 13h.01M10 13h.01M13.5 13h.01M17 13h.01M8.5 16h7" />
    </IconBase>
  );
}

export function AttachScreenIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="14" height="14" rx="2.5" />
      <circle cx="7.75" cy="8.75" r="1.25" />
      <path d="m3.5 15 4-4 3.25 3.25 2.25-2.25L16.5 15.5" />
      <path d="M19.5 15.5v5M17 18h5" />
    </IconBase>
  );
}

export function SparkleInspectIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11 3.5 12.6 8l4.4 1.6-4.4 1.6-1.6 4.5-1.6-4.5L5 9.6 9.4 8 11 3.5Z" />
      <path d="M18.5 14.5 19.3 16.7l2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </IconBase>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 3 10 14" />
      <path d="M21 3 14.5 21 10 14 3 9.5 21 3Z" />
    </IconBase>
  );
}

export function ReturnKeyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M19 6v5a3 3 0 0 1-3 3H5.5" />
      <path d="m9 10.5-3.5 3.5L9 17.5" />
    </IconBase>
  );
}

export function BackspaceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 5.5H9.5L3.5 12l6 6.5H20a1.5 1.5 0 0 0 1.5-1.5V7A1.5 1.5 0 0 0 20 5.5Z" />
      <path d="m12 9.5 5 5M17 9.5l-5 5" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 6 18 18M18 6 6 18" />
    </IconBase>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </IconBase>
  );
}
