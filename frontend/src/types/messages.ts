export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type?: string;
  api_state?: string;
  provider?: string;
}

export interface ActionNode {
  action_id: string;
  action_type: string;
  timestamp: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: any;
  metadata?: Record<string, any>;
}

export interface PlanStep {
  step_id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: string | null;
  metadata?: Record<string, any>;
}

export interface ExecutionPlan {
  plan_id: string;
  task_description: string;
  steps: PlanStep[];
  created_at?: string;
  updated_at?: string;
}

export interface ContextSnapshot {
  snapshot_id: string;
  timestamp: string;
  context_size: number;
  summary: string;
  full_context?: Record<string, any>;
}

export interface DomainExecution {
  task_id: string;
  domain_id: string;
  agent_id: string;
  status: 'starting' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'aborted';
  actions: ActionNode[];
  plan?: ExecutionPlan | null;
  context_snapshots: ContextSnapshot[];
  output?: string;
  agent_message?: string;
  pending_tool?: {
    call_id: string;
    tool: string;
    params: Array<[string, any]>;
    reason: string;
    message: string;
    created_at: string;
    tool_description?: string;
  } | null;
  tool_history?: Array<{
    call_id: string;
    tool: string;
    params: Array<[string, any]>;
    accepted: boolean;
    executed_at: string;
    result_summary: string;
    raw_result?: any;
    error?: string | null;
  }>;
  metadata?: {
    iterations?: number;
    tool_calls?: number;
    elapsed_seconds?: number;
  };
  assistant_message_id?: string | number | null;
}

export interface RouterDecision {
  selectedRoute: string | null;
  availableRoutes: any[];
  selectedModel: string | null;
  toolsNeeded?: boolean | null;
  executionType?: string | null;
  fastpathParams?: string | null;
  error?: string | null;
}

export interface Message {
  id: string;
  clientId?: string;
  role: 'user' | 'assistant';
  content: string;
  thoughts?: string;
  provider?: string;
  model?: string;
  timestamp: string;
  attachedFiles?: AttachedFile[];
  routerEnabled?: boolean;
  routerDecision?: {
    route: string;
    available_routes: any[];
    selected_model: string | null;
    tools_needed?: boolean | null;
    execution_type?: string | null;
    fastpath_params?: string | null;
  };
  domainExecution?: DomainExecution;
  planId?: string;
}

