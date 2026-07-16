import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type WorkbenchLeftPanel = "files" | "search" | "rules" | "memory" | "git";

type UseWorkbenchLayoutOptions = {
  onSaveFile: () => Promise<unknown> | void;
};

// 管理工作台壳层的尺寸、拖拽和快捷键，避免入口组件被界面状态淹没。
export function useWorkbenchLayout({ onSaveFile }: UseWorkbenchLayoutOptions) {
  const [chatWidth, setChatWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [leftPanel, setLeftPanel] = useState<WorkbenchLeftPanel>("files");
  const resizingChat = useRef(false);
  const resizingTerminal = useRef(false);

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

  return {
    chatWidth,
    terminalHeight,
    terminalOpen,
    setTerminalOpen,
    leftPanel,
    setLeftPanel,
    handleStartChatResize,
    handleStartTerminalResize,
    handleCloseTerminal
  };
}
