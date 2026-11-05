/** Active guidance read from the conversation's host-bound memory scope. */
export type ChatRuleScope = 'global' | 'project';

export type ChatRule = {
  path: string;
  scope: ChatRuleScope;
  title: string;
  content: string;
  revision: string;
  editable: boolean;
};

export type ChatRules = {
  enabled: boolean;
  writable: boolean;
  projectAvailable: boolean;
  overBudget: boolean;
  rules: ChatRule[];
};

export type ChatRuleMutation =
  | { action: 'add'; scope: ChatRuleScope; title: string; content: string }
  | { action: 'edit'; scope: ChatRuleScope; path: string; revision: string; title: string; content: string }
  | { action: 'delete'; scope: ChatRuleScope; path: string; revision: string };

export type ProjectRuleFile = {
  id: string;
  rootLabel: string;
  path: string;
  revision: string;
  writable: boolean;
  condition?: string | null;
  rules: Array<{ id: string; title: string; content: string }>;
};
export type ProjectRuleFiles = { projectId: string | null; files: ProjectRuleFile[] };
export type ProjectFileMutation =
  | { action: 'add'; fileId: string; revision: string; title: string; content: string }
  | { action: 'edit'; fileId: string; revision: string; ruleId: string; title: string; content: string }
  | { action: 'delete'; fileId: string; revision: string; ruleId: string };
