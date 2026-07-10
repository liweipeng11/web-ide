// 兼容旧搜索入口，实际实现已经迁移到 codeDiscovery/textSearch。
export { searchTextLiteral, searchTextRegex, searchWorkspaceCode } from "./codeDiscovery/textSearch.js";
export type { CodeSearchResult, TextSearchOptions } from "./codeDiscovery/types.js";
