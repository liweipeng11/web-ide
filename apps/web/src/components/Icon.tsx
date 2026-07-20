type IconName =
  | "apply"
  | "branch"
  | "chat"
  | "clear"
  | "close"
  | "copy"
  | "delete"
  | "diff"
  | "edit"
  | "folder-open"
  | "history"
  | "focus"
  | "panel-right"
  | "reject"
  | "save"
  | "search"
  | "send"
  | "settings"
  | "stop"
  | "terminal";

type Props = {
  name: IconName;
};

const paths: Record<IconName, string[]> = {
  apply: ["M20 6 9 17l-5-5"],
  branch: ["M6 3v6a3 3 0 0 0 3 3h6", "M18 9v6", "M15 12l3-3 3 3", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  chat: ["M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-5 4z"],
  clear: ["M4 7h16", "M9 7V5h6v2", "M7 7l1 13h8l1-13"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  copy: ["M8 8h10v12H8z", "M6 16H4V4h12v2"],
  delete: ["M4 7h16", "M9 7V5h6v2", "M10 11v6", "M14 11v6", "M7 7l1 13h8l1-13"],
  diff: ["M6 5h12", "M6 12h8", "M6 19h12", "M16 10l3 2-3 2"],
  edit: ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M14 7l3 3"],
  "folder-open": ["M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5", "M3 9h18l-2 10H5z"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 7v5l3 2"],
  focus: ["M8 3H3v5", "M16 3h5v5", "M21 16v5h-5", "M3 16v5h5"],
  "panel-right": ["M4 4h16v16H4z", "M15 4v16"],
  reject: ["M6 6l12 12", "M18 6 6 18"],
  save: ["M5 4h12l2 2v14H5z", "M8 4v6h8V4", "M8 20v-6h8v6"],
  search: ["m20 20-4.4-4.4", "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"],
  send: ["M4 4l17 8-17 8 4-8z", "M8 12h13"],
  settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.02 1.57V20h-3v-.09a1.7 1.7 0 0 0-1.02-1.57 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7.04 15a1.7 1.7 0 0 0-1.57-1.02H5v-3h.09a1.7 1.7 0 0 0 1.57-1.02A1.7 1.7 0 0 0 6.32 8.1l-.06-.06 2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.34 4.7V4h3v.09a1.7 1.7 0 0 0 1.02 1.57 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.57 1.02H20v3h-.09A1.7 1.7 0 0 0 19.4 15Z"],
  stop: ["M7 7h10v10H7z"],
  terminal: ["M4 6h16v12H4z", "M7 10l3 2-3 2", "M12 15h5"]
};

export default function Icon({ name }: Props) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
