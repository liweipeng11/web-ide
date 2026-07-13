export type PackageManagerAnalysis = {
  name: string | null;
  lockfile: string | null;
  workspaceFile: string | null;
  packageJsonFiles: string[];
};

export type TechStackAnalysis = {
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  lintTools: string[];
  typeSystems: string[];
  configFiles: string[];
};

export type ProjectStructureSummary = {
  rootEntries: string[];
  sourceDirectories: string[];
  workspacePackages: string[];
};

export type TestSystemAnalysis = {
  tools: string[];
  configFiles: string[];
  testFiles: string[];
  hasTests: boolean;
};

export type ValidationCommandCandidate = {
  name: string;
  command: string;
  source: string;
  reason: string;
};

export type HighRiskDirectory = {
  path: string;
  reason: string;
};

export type ProjectAnalysis = {
  packageManager: PackageManagerAnalysis;
  techStack: TechStackAnalysis;
  structure: ProjectStructureSummary;
  testSystem: TestSystemAnalysis;
  validationCommands: ValidationCommandCandidate[];
  highRiskDirectories: HighRiskDirectory[];
};

export type PackageJsonInfo = {
  relativePath: string;
  directory: string;
  name: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
