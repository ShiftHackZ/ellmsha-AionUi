export type CopilotIdeStatus = {
  enabled: boolean;
  running: boolean;
  starting: boolean;
  busy: boolean;
  models: string[];
  runtimeAvailable: boolean;
};
export type CopilotIdeAction = 'status' | 'enable' | 'disable' | 'login' | 'refresh' | 'stop';
export type ProjectIndexCatalog = {
  project_id: string | null;
  name: string;
  workspace: string;
  repositories: Array<{
    name: string;
    path: string;
    code_graph_id?: string;
    status: string;
    indexed_at?: string | null;
    error?: string;
    stats?: { files: number; nodes: number; edges: number } | null;
  }>;
  errors: Array<{ path: string; error: string }>;
};
export type ProjectIndexResult = { results: Array<{ repository: string; accepted: boolean; error?: string }> };
export type MemoryEmbeddingInput = { baseUrl: string; model: string; apiKey?: string };
export type MemoryEmbeddingStatus = {
  available: boolean;
  phase: string;
  done: number;
  total: number;
  layer?: string;
  current?: { baseUrl: string; model: string; dimensions: number; hasApiKey: boolean };
};
// WebUI 状态接口 / WebUI status interface
export interface WebUIStatus {
  running: boolean;
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  adminUsername: string;
  initialPassword?: string;
}

export interface ElectronBridgeAPI {
  copilotIde?: (action: CopilotIdeAction) => Promise<CopilotIdeStatus>;
  emit: (name: string, data: unknown) => Promise<unknown> | void;
  on: (callback: (event: { value: string }) => void) => void;
  // 获取拖拽文件/目录的绝对路径 / Get absolute path for dragged file/directory
  getPathForFile?: (file: File) => string;
  // Feedback log collection / 收集反馈日志
  collectFeedbackLogs?: () => Promise<{ filename: string; data: number[] } | null>;
  // Feedback screenshot capture / 反馈截图
  captureFeedbackScreenshot?: () => Promise<{ filename: string; data: number[] } | null>;
  // Forward feedback diagnostics logs to the main process console / 转发反馈诊断日志到主进程控制台
  logFeedbackEvent?: (payload: { details?: unknown; level: 'info' | 'warn' | 'error'; message: string }) => void;
  recoverCorruptedDatabase?: () => Promise<void>;
  memoryProject?: {
    (input: { projectId: string; action: 'catalog' }): Promise<ProjectIndexCatalog>;
    (input: { projectId: string; action: 'index'; repository?: string }): Promise<ProjectIndexResult>;
  };
  getMemoryEmbedding?: () => Promise<MemoryEmbeddingStatus>;
  probeMemoryEmbedding?: (input: MemoryEmbeddingInput) => Promise<{ dimensions: number }>;
  applyMemoryEmbedding?: (input: MemoryEmbeddingInput) => Promise<void>;
  getMemoryPanelUrl?: () => Promise<string>;
  getLocalMemoryKey?: () => Promise<string | null>;
  verifyMemoryKey?: (
    key: string
  ) => Promise<{ instanceId: string; user: { user_id: string; username: string; display_name?: string } }>;
}

export type BackendStartupFailureReason =
  | 'backend_incompatible_runtime'
  | 'backend_incomplete_installation'
  | 'backend_package_architecture_mismatch'
  | 'backend_data_migration_failed'
  | 'backend_local_data_repair_failed'
  | 'backend_recoverable_database_corruption'
  | 'backend_transient_concurrent_startup'
  | 'backend_startup_directory_unavailable'
  // Backend process spawned and was observed listening but /health did not pass
  // within the timeout, while the process stayed alive (kept pending). Recoverable
  // "slow startup" — must NOT be surfaced as an "incomplete installation".
  | 'backend_startup_pending_slow'
  // Backend process spawned and was observed listening but then exited before
  // becoming ready (either within the health window or after the pending timeout).
  // Honest startup failure — surfaced without reinstall/antivirus guidance.
  | 'backend_startup_exited'
  | 'backend_startup_failed';

export type BackendIncompleteInstallationKind = 'missing_backend_binary' | 'missing_directory_resources';
export type BackendLocalDataIssueKind = 'agent_metadata_invalid_utf8' | 'assistant_storage_bootstrap_failed';
export type BackendStartupDirectoryIssueKind = 'missing_or_unavailable_directory' | 'permission_denied';

export interface BackendStartupFailureInfo {
  incompleteInstallationKind?: BackendIncompleteInstallationKind;
  localDataIssueKind?: BackendLocalDataIssueKind;
  startupDirectoryIssueKind?: BackendStartupDirectoryIssueKind;
  missingBackendBinary?: boolean;
  missingBundledAioncoreDir?: boolean;
  missingHubDir?: boolean;
  missingPetStatesDir?: boolean;
  missingPwaDir?: boolean;
  reason: BackendStartupFailureReason;
  backendBoundaryCode?: string;
  backendBoundaryStage?: string;
  runtime?: 'glibc';
  requiredVersions?: string[];
  missingResources?: string[];
  missingRuntimeDir?: boolean;
  packageArch?: string;
  deviceArch?: string;
  expectedDownloadArch?: string;
  isRosettaTranslated?: boolean;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeAPI;
    __initialLanguage?: string | null;
    __aionuiE2ETest?: boolean;
    __backendStartupFailed?: boolean;
    __backendStartupFailure?: BackendStartupFailureInfo | null;
    __backendStartupBridge?: {
      getState: () => BackendStartupFailureInfo | null;
      subscribe: (callback: (state: BackendStartupFailureInfo | null) => void) => () => void;
    };
    __installationIntegrityReportCount?: number;
    __lastInstallationIntegrityReportMessage?: string;
  }
}
