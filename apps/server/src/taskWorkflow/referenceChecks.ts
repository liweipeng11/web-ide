import type { ExistenceCheckTarget, ReferenceResolution } from "../existenceChecker/types.js";

/** 为引用目标生成稳定 key，使同一目标的新检查可以覆盖旧检查。 */
export function createReferenceCheckKey(target: ExistenceCheckTarget) {
  return JSON.stringify([
    target.kind,
    target.value.trim(),
    target.fromPath?.replaceAll("\\", "/").replace(/^\.\//, "") || "",
    target.environmentMode || ""
  ]);
}

export function parseReferenceCheckKey(key: string): ExistenceCheckTarget | null {
  try {
    const value = JSON.parse(key);
    if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string") return null;
    return {
      kind: value[0] as ExistenceCheckTarget["kind"],
      value: value[1],
      ...(typeof value[2] === "string" && value[2] ? { fromPath: value[2] } : {}),
      ...(typeof value[3] === "string" && value[3] ? { environmentMode: value[3] } : {})
    };
  } catch {
    return null;
  }
}

export function cloneReferenceChecks(checks?: Record<string, ReferenceResolution>) {
  if (!checks) return undefined;
  return Object.fromEntries(
    Object.entries(checks).map(([key, resolution]) => [
      key,
      { ...resolution, candidates: resolution.candidates.map((candidate) => ({ ...candidate })) }
    ])
  );
}
