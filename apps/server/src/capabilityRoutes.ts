import express from "express";
import { config } from "./config.js";
import { createServerCapabilities, implementedFeatures, readFeatureFlags, type FeatureFlags, type FeatureImplementations } from "./featureFlags.js";

export function createCapabilityRouter(options: { flags?: FeatureFlags; implementations?: FeatureImplementations; aiConfigured?: boolean; defaultModel?: string } = {}) {
  const router = express.Router();

  router.get("/capabilities", (_request, response) => {
    response.json(
      createServerCapabilities({
        flags: options.flags ?? readFeatureFlags(),
        implementations: options.implementations ?? implementedFeatures,
        aiConfigured: options.aiConfigured ?? Boolean(config.aiApiKey),
        defaultModel: options.defaultModel ?? config.aiModel
      })
    );
  });

  return router;
}
