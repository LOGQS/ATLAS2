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
}

