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
  | "memory"
  | "reject"
  | "rules"
  | "save"
  | "search"
  | "send"
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
  memory: ["M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5.2A3 3 0 0 0 7 18h2", "M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5.2A3 3 0 0 1 17 18h-2", "M9 4v16", "M15 4v16", "M9 9h3", "M12 15h3"],
  reject: ["M6 6l12 12", "M18 6 6 18"],
  rules: ["M6 4h9l3 3v13H6z", "M14 4v4h4", "M9 11h6", "M9 15h6", "M9 19h4"],
  save: ["M5 4h12l2 2v14H5z", "M8 4v6h8V4", "M8 20v-6h8v6"],
  search: ["m20 20-4.4-4.4", "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"],
  send: ["M4 4l17 8-17 8 4-8z", "M8 12h13"],
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
