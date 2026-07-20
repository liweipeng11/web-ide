import express from "express";
import type { ModelSelection, ModelSelectionDefaults } from "./contracts/model.js";
import { readModelDefaults, writeModelDefaults } from "./modelSelectionStore.js";
import { createProviderSettings, readProviderRuntimeSettings, readProviderSettings, testProviderConnection, writeProviderSettings } from "./providerSettingsStore.js";
import { configureProviderGateway, providerGateway } from "./providers/index.js";

async function syncProviderGateway() {
  const providers = await readProviderRuntimeSettings();
  configureProviderGateway(providers.filter((provider) => provider.enabled));
  return providers;
}

export function createModelRouter() {
  const router = express.Router();

  router.get("/models", async (_request, response, next) => {
    try {
      await syncProviderGateway();
      response.json({
        providers: await providerGateway.listCatalog(),
        defaults: await readModelDefaults(),
        providerSettings: await readProviderSettings()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/models/providers", async (request, response, next) => {
    try {
      const result = await createProviderSettings(request.body);
      configureProviderGateway(result.providers.filter((provider) => provider.enabled));
      response.json({
        settings: result.settings,
        providerSettings: await readProviderSettings(),
        providers: await providerGateway.listCatalog()
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/models/provider-settings", async (request, response, next) => {
    try {
      const result = await writeProviderSettings(request.body);
      const enabledProviders = result.providers.filter((provider) => provider.enabled);
      configureProviderGateway(enabledProviders);
      const currentDefaults = await readModelDefaults();
      const fallbackProvider = enabledProviders.find((provider) => provider.id === result.settings.providerId) || enabledProviders[0];
      const fallback = { providerId: fallbackProvider.id, modelId: fallbackProvider.models[0] };
      const keepOrFallback = (selection: ModelSelection): ModelSelection => {
        const provider = enabledProviders.find((item) => item.id === selection.providerId);
        return provider?.models.includes(selection.modelId) ? selection : fallback;
      };
      const defaults = await writeModelDefaults({
        chat: keepOrFallback(currentDefaults.chat),
        plan: keepOrFallback(currentDefaults.plan),
        act: keepOrFallback(currentDefaults.act)
      });
      response.json({
        settings: result.settings,
        providerSettings: await readProviderSettings(),
        defaults,
        providers: await providerGateway.listCatalog()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/models/provider-settings/test", async (request, response, next) => {
    try {
      response.json(await testProviderConnection(request.body));
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
