export type LanguageServiceCapability = {
  languageId: string;
  diagnostics: boolean;
  definition: boolean;
  references: boolean;
  hover: boolean;
  rename: boolean;
  source: "lsp" | "symbol_graph" | "combined";
};

