

export interface TokenSegment {
  label: string;
  tokens: number;
  method: string;
  is_estimated?: boolean;
  char_count?: number;
  details?: FileTokenBreakdown[];
}

export interface FileTokenBreakdown {
  file: string;
  estimated_tokens: number;
  method: string;
}

export interface TokenTotal {
  tokens: number;
  method: string;
  is_estimated?: boolean;
}

export interface TokenBundle {
  total: TokenTotal;
  segments: TokenSegment[];
}

export interface RequestAnalysis {
  role: 'router' | 'planner' | 'assistant' | 'agent_tool';
  label: string;
  provider: string;
  model: string;
  input: TokenBundle;
  output?: TokenBundle;
  notes?: string[];
}

export interface SystemPromptInfo {
  content?: string | null;
  tokens: number;
  method: string;
  is_estimated?: boolean;
}

export interface ContextAnalysisData {
  chat_id: string;
  system_prompt: SystemPromptInfo;
  requests: RequestAnalysis[];
  generated_at: number;
}

export interface ContextAnalysisResponse {
  success: boolean;
  data?: ContextAnalysisData;
  error?: string;
}
