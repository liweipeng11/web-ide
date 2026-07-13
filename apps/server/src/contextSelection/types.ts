export type ContextSelectionToolName =
  | "searchFilesByName"
  | "listCodeDefinitionNames"
  | "searchCode"
  | "searchCodeRegex"
  | "readFile"
  | "readFileChunk"
  | "readFileRange"
  | "selectedFile"
  | "taskSession";

export type CandidateFileRole = "target" | "companion" | "context";

export type EvidenceType = "filename" | "definition" | "text_match" | "import_relation" | "selected_file" | "previous_failure" | "session_history";

export type CandidateFileRecord = {
  filePath: string;
  role: CandidateFileRole;
  score: number;
  reasons: string[];
  read: boolean;
  fromTools: ContextSelectionToolName[];
};

export type EvidenceRecord = {
  filePath: string;
  evidenceType: EvidenceType;
  sourceTool: string;
  detail: string;
  line?: number;
  score: number;
};

export type RequiredCompanionFile = {
  filePath: string;
  reason: string;
  requiredBy: string;
  status: "pending" | "read" | "missing";
};

export type MissingRequirementRecord = {
  requirement: string;
  reason: string;
  severity: "warning" | "blocking";
  relatedFiles: string[];
};

export type ContextSelectionSnapshot = {
  taskSessionId?: string | null;
  userGoal: string;
  candidateFiles: CandidateFileRecord[];
  evidence: EvidenceRecord[];
  requiredCompanions: RequiredCompanionFile[];
  missingRequirements: MissingRequirementRecord[];
  readyForPatch: boolean;
  summary: string;
  createdAt: number;
};

export type PatchCompletenessReport = {
  ready: boolean;
  risks: MissingRequirementRecord[];
  checkedFiles: string[];
  createdAt: number;
};

export type ContextSelectionInput = {
  taskSessionId?: string | null;
  userGoal: string;
  selectedFilePath?: string | null;
  filesRead?: string[];
  searchResultFiles?: string[];
  previousFailureFiles?: string[];
};
