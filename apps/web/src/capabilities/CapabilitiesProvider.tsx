import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { fetchServerCapabilities, type ServerCapabilities } from "../api";

type CapabilitiesState = {
  capabilities: ServerCapabilities | null;
  loading: boolean;
  error: string | null;
};

const CapabilitiesContext = createContext<CapabilitiesState>({ capabilities: null, loading: true, error: null });

export function CapabilitiesProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<CapabilitiesState>({ capabilities: null, loading: true, error: null });

  useEffect(() => {
    let active = true;
    // 应用启动时只读取服务端裁决后的能力；请求失败时保持新功能不可用。
    fetchServerCapabilities()
      .then((capabilities) => active && setState({ capabilities, loading: false, error: null }))
      .catch((error: unknown) => active && setState({ capabilities: null, loading: false, error: error instanceof Error ? error.message : "能力检测失败" }));
    return () => { active = false; };
  }, []);

  return <CapabilitiesContext.Provider value={state}>{children}</CapabilitiesContext.Provider>;
}

export function useServerCapabilities() {
  return useContext(CapabilitiesContext);
}

