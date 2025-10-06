export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type?: string;
  api_state?: string;
  provider?: string;
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
  planId?: string;
}

