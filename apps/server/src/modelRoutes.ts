import express from "express";
import type { ModelSelectionDefaults } from "./contracts/model.js";
import { readModelDefaults, writeModelDefaults } from "./modelSelectionStore.js";
import { providerGateway } from "./providers/index.js";

export function createModelRouter() {
  const router = express.Router();

  router.get("/models", async (_request, response, next) => {
    try {
      response.json({ providers: await providerGateway.listCatalog(), defaults: await readModelDefaults() });
    } catch (error) {
      next(error);
    }
  });

  router.put("/models/defaults", async (request, response, next) => {
    try {
      response.json({ defaults: await writeModelDefaults(request.body as ModelSelectionDefaults) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
