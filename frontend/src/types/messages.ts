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
  status: 'starting' | 'running' | 'completed' | 'failed';
  actions: ActionNode[];
  plan?: ExecutionPlan | null;
  context_snapshots: ContextSnapshot[];
  output?: string;
}

export interface RouterDecision {
  selectedRoute: string | null;
  availableRoutes: any[];
  selectedModel: string | null;
  toolsNeeded?: boolean | null;
  executionType?: string | null;
  fastpathParams?: string | null;
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

