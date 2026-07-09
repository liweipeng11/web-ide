import { Router, type NextFunction, type Request, type Response } from "express";
import { parseVue2TemplateRequest } from "./requestParser.js";
import { applyVue2TemplateFragments } from "./vue2TemplateService.js";

export function createVue2TemplateRouter() {
  const router = Router();

  const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };

  router.post(
    "/",
    asyncRoute(async (request, response) => {
      const { template, fragments } = parseVue2TemplateRequest(request.body);

      // 路由层只做参数标准化和响应封装，具体 Vue2 合并规则交给 service 维护。
      response.json({
        result: applyVue2TemplateFragments(template, fragments)
      });
    })
  );

  return router;
}
