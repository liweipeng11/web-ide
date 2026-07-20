import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type WorkbenchLeftPanel = "files" | "search" | "git";

type UseWorkbenchLayoutOptions = {
  onSaveFile: () => Promise<unknown> | void;
};

type LayoutPreferences = {
  chatWidth?: number;
  terminalHeight?: number;
  terminalOpen?: boolean;
  leftPanel?: WorkbenchLeftPanel;
  leftPanelOpen?: boolean;
  chatPanelOpen?: boolean;
  focusMode?: boolean;
};

const LAYOUT_PREFERENCES_KEY = "mini-ai-web-editor:layout";

function readLayoutPreferences(): LayoutPreferences {
  try {
    const preferences = JSON.parse(window.localStorage.getItem(LAYOUT_PREFERENCES_KEY) || "{}") as LayoutPreferences;
    // 已迁移到设置页的旧面板不再恢复，避免启动后出现空白侧栏。
    if (!["files", "search", "git"].includes(preferences.leftPanel || "")) preferences.leftPanel = "files";
    return preferences;
  } catch {
    // 本地偏好损坏时回退到安全默认值，不影响工作台启动。
    return {};
  }
}

// 管理工作台壳层的尺寸、拖拽和快捷键，避免入口组件被界面状态淹没。
export function useWorkbenchLayout({ onSaveFile }: UseWorkbenchLayoutOptions) {
  const initialPreferencesRef = useRef<LayoutPreferences | null>(null);
  if (initialPreferencesRef.current === null) initialPreferencesRef.current = readLayoutPreferences();
  const initialPreferences = initialPreferencesRef.current;
  const compactViewport = window.innerWidth <= 1000;
  const [chatWidth, setChatWidth] = useState(initialPreferences.chatWidth ?? 320);
  const [terminalHeight, setTerminalHeight] = useState(initialPreferences.terminalHeight ?? 220);
  const [terminalOpen, setTerminalOpen] = useState(initialPreferences.terminalOpen ?? false);
  const [leftPanel, setLeftPanel] = useState<WorkbenchLeftPanel>(initialPreferences.leftPanel ?? "files");
  const [leftPanelOpen, setLeftPanelOpen] = useState(initialPreferences.leftPanelOpen ?? !compactViewport);
  const [chatPanelOpen, setChatPanelOpen] = useState(initialPreferences.chatPanelOpen ?? !compactViewport);
  const [focusMode, setFocusMode] = useState(initialPreferences.focusMode ?? false);
  const resizingChat = useRef(false);
  const resizingTerminal = useRef(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LAYOUT_PREFERENCES_KEY,
        JSON.stringify({ chatWidth, terminalHeight, terminalOpen, leftPanel, leftPanelOpen, chatPanelOpen, focusMode } satisfies LayoutPreferences)
      );
    } catch {
      // 隐私模式或存储额度不足时忽略持久化失败，界面状态仍在当前会话有效。
    }
  }, [chatPanelOpen, chatWidth, focusMode, leftPanel, leftPanelOpen, terminalHeight, terminalOpen]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (resizingChat.current) {
        const nextWidth = Math.min(560, Math.max(240, window.innerWidth - event.clientX));
        setChatWidth(nextWidth);
      }

      if (resizingTerminal.current) {
        const nextHeight = Math.min(Math.floor(window.innerHeight * 0.55), Math.max(120, window.innerHeight - event.clientY));
        setTerminalHeight(nextHeight);
      }
    }

    function handlePointerUp() {
      resizingChat.current = false;
      resizingTerminal.current = false;
      document.body.classList.remove("resizing-chat");
      document.body.classList.remove("resizing-terminal");
    }

    window.addEventListener("pointermove", handlePointerMove as unknown as EventListener);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove as unknown as EventListener);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isTerminalShortcut = (event.ctrlKey || event.metaKey) && (event.key === "`" || event.code === "Backquote");

      if (!isTerminalShortcut || event.repeat) return;

      event.preventDefault();
      resizingTerminal.current = false;
      document.body.classList.remove("resizing-terminal");
      setTerminalOpen((current) => !current);
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSearchShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f";

      if (!isSearchShortcut) return;

      setLeftPanel("search");
      setLeftPanelOpen(true);
      setFocusMode(false);
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";

      if (!isSaveShortcut || event.repeat) return;

      event.preventDefault();
      void onSaveFile();
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onSaveFile]);

  function handleStartChatResize(event: ReactPointerEvent) {
    event.preventDefault();
    resizingChat.current = true;
    document.body.classList.add("resizing-chat");
  }

  function handleStartTerminalResize(event: ReactPointerEvent) {
    event.preventDefault();
    resizingTerminal.current = true;
    document.body.classList.add("resizing-terminal");
  }

  function handleCloseTerminal() {
    resizingTerminal.current = false;
    document.body.classList.remove("resizing-terminal");
    setTerminalOpen(false);
  }

  function handleSelectLeftPanel(panel: WorkbenchLeftPanel) {
    // 再次点击当前活动入口时收起侧栏，切换入口时直接展示目标面板。
    setFocusMode(false);
    if (leftPanel === panel) {
      setLeftPanelOpen((current) => !current);
      return;
    }

    setLeftPanel(panel);
    setLeftPanelOpen(true);
  }

  function handleToggleChatPanel() {
    setFocusMode(false);
    setChatPanelOpen((current) => !current);
  }

  function handleToggleFocusMode() {
    // 专注模式仅临时隐藏辅助区域，退出后恢复用户之前的展开状态。
    setFocusMode((current) => !current);
  }

  return {
    chatWidth,
    terminalHeight,
    terminalOpen,
    setTerminalOpen,
    leftPanel,
    leftPanelOpen,
    chatPanelOpen,
    focusMode,
    handleSelectLeftPanel,
    handleToggleChatPanel,
    handleToggleFocusMode,
    handleStartChatResize,
    handleStartTerminalResize,
    handleCloseTerminal
  };
}
