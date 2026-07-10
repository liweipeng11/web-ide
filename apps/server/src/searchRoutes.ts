import express, { type Request } from "express";
import { searchTextRegex, searchWorkspaceCode, searchWorkspaceFilesByName } from "./codeDiscovery/index.js";

function getStringQuery(request: Request, name: string) {
  const value = request.query[name];
  return typeof value === "string" ? value : "";
}

function getOptionalNumberQuery(request: Request, name: string) {
  const value = getStringQuery(request, name).trim();
  return value ? Number(value) : undefined;
}

/**
 * 创建代码搜索路由。
 * 该模块只负责 HTTP 参数解析和 discovery 能力编排，避免主入口继续堆积业务路由细节。
 */
export function createSearchRouter() {
  const router = express.Router();

  router.get("/search", async (request, response, next) => {
    try {
      const query = getStringQuery(request, "q");
      const mode = request.query.mode === "regex" ? "regex" : "literal";
      const options = {
        path: getStringQuery(request, "path"),
        filePattern: getStringQuery(request, "filePattern"),
        limit: getOptionalNumberQuery(request, "limit"),
        contextLines: getOptionalNumberQuery(request, "contextLines"),
        caseSensitive: request.query.caseSensitive === "true"
      };

      // 默认保持旧接口的字面量搜索语义；只有显式 mode=regex 时才走正则搜索。
      response.json({ results: mode === "regex" ? await searchTextRegex(query, options) : await searchWorkspaceCode(query, options) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/search/files", async (request, response, next) => {
    try {
      const query = getStringQuery(request, "q");
      const path = getStringQuery(request, "path");
      const limit = getOptionalNumberQuery(request, "limit");

      // 文件名搜索只做路径发现，不读取文件正文，用于前端和 Agent 的低成本定位。
      response.json({ results: await searchWorkspaceFilesByName(query, path, limit) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
