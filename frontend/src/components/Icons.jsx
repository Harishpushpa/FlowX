// Small inline icon set. Drawn on a 16px grid with currentColor so they
// follow the theme (light/dark) and the text color of whatever they sit in.
function Svg({ children, size = 16, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconChevron = ({ open = false, ...p }) => (
  <Svg
    {...p}
    style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s ease" }}
  >
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);

export const IconChevronDown = (p) => (
  <Svg {...p}>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);

export const IconPlus = (p) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconFolderPlus = (p) => (
  <Svg {...p}>
    <path d="M1.75 4.5A1.25 1.25 0 0 1 3 3.25h2.6l1.4 1.6H13A1.25 1.25 0 0 1 14.25 6.1v5.65A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25z" />
    <path d="M8 7.4v3.2M6.4 9h3.2" />
  </Svg>
);

export const IconSun = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
  </Svg>
);

export const IconMoon = (p) => (
  <Svg {...p}>
    <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" />
  </Svg>
);

export const IconArrowUp = (p) => (
  <Svg {...p}>
    <path d="M8 13V3M3.8 7.2 8 3l4.2 4.2" />
  </Svg>
);

export const IconArrowDown = (p) => (
  <Svg {...p}>
    <path d="M8 3v10M3.8 8.8 8 13l4.2-4.2" />
  </Svg>
);

export const IconTrash = (p) => (
  <Svg {...p}>
    <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.6 8.5h6.8l.6-8.5" />
  </Svg>
);

export const IconTable = (p) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M2 6.5h12M6 6.5V13" />
  </Svg>
);

export const IconApi = (p) => (
  <Svg {...p}>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </Svg>
);

export const IconMenu = (p) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);

export const IconClose = (p) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconSearch = (p) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.3 10.3 3.2 3.2" />
  </Svg>
);

export const IconCheck = (p) => (
  <Svg {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);

export const IconLogout = (p) => (
  <Svg {...p}>
    <path d="M6.5 2.75h-3a.75.75 0 0 0-.75.75v9c0 .41.34.75.75.75h3M10 5l3 3-3 3M13 8H6.5" />
  </Svg>
);
