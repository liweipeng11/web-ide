import { useEffect, useRef, useState } from "react";
import { fetchLanguageDiagnostics, fetchLanguageServiceCapabilities, syncLanguageDocument, type LanguageServiceCapability, type UnifiedDiagnostic } from "../api";

type Options = { path: string | null; content: string; saved: boolean };

/** 同步 Monaco 未保存文档，并用单调版本号拒绝过期诊断。 */
export function useLanguageService({ path, content, saved }: Options) {
  const [capability, setCapability] = useState<LanguageServiceCapability | null>(null);
  const [diagnostics, setDiagnostics] = useState<UnifiedDiagnostic[]>([]);
  const versions = useRef(new Map<string, number>());
  const lastContent = useRef(new Map<string, string>());
  const currentVersion = path ? versions.current.get(path) ?? 0 : 0;

  useEffect(() => {
    if (!path) {
      setCapability(null);
      setDiagnostics([]);
      return;
    }
    let active = true;
    const version = (versions.current.get(path) ?? 0) + 1;
    versions.current.set(path, version);
    lastContent.current.set(path, content);
    void Promise.all([
      fetchLanguageServiceCapabilities(path),
      syncLanguageDocument({ filePath: path, content, version, action: "open" })
    ]).then(([nextCapability]) => {
      if (active) {
        setCapability(nextCapability);
      }
    }).catch(() => {
      if (active) setCapability(null);
    });

    return () => {
      active = false;
      const closingVersion = versions.current.get(path) ?? version;
      void syncLanguageDocument({ filePath: path, version: closingVersion, action: "close" }).catch(() => undefined);
    };
    // 只在切换文件时执行 didOpen/didClose；内容变化由下方 didChange 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (!path || lastContent.current.get(path) === content) return;
    const version = (versions.current.get(path) ?? 0) + 1;
    versions.current.set(path, version);
    lastContent.current.set(path, content);
    const timer = window.setTimeout(async () => {
      try {
        await syncLanguageDocument({ filePath: path, content, version, action: "change" });
        const result = await fetchLanguageDiagnostics(path, version);
        if ((versions.current.get(path) ?? -1) === version) setDiagnostics(result.diagnostics);
      } catch {
        if ((versions.current.get(path) ?? -1) === version) setDiagnostics([]);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [path, content]);

  useEffect(() => {
    if (!path || !capability?.diagnostics) return;
    let active = true;
    let requesting = false;
    const refresh = async () => {
      if (requesting) return;
      requesting = true;
      const version = versions.current.get(path) ?? 0;
      try {
        const result = await fetchLanguageDiagnostics(path, version);
        if (active && (versions.current.get(path) ?? -1) === version) setDiagnostics(result.diagnostics);
      } catch {
        // Language Server 重启期间保留现有 Marker，下一轮轮询会自动恢复。
      } finally {
        requesting = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 600);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [path, capability?.diagnostics]);

  useEffect(() => {
    if (!path || !saved) return;
    const version = versions.current.get(path) ?? 0;
    void syncLanguageDocument({ filePath: path, content, version, action: "save" }).catch(() => undefined);
  }, [path, content, saved]);

  return { capability, diagnostics, documentVersion: currentVersion };
}
