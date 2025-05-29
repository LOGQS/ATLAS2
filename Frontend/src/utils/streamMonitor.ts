interface CreationData {
  type: string;
  title: string;
  language?: string;
  content: string;
  is_complete: boolean;
  start_position: number;
  end_position?: number;
  start_tag: string;
  end_tag?: string;
}

interface OutsideCreationData {
  content: string;
  is_active: boolean;
  position: number;
  end_position?: number;
  after_creation?: string;
  error?: string;
}

interface StreamLogData {
  streaming_id: string;
  chat_id: string;
  started_at: string;
  full_accumulated_content: string;
  outside_creations: Record<string, OutsideCreationData>;
  current_outside_index: number;
  inside_creations: Record<string, CreationData>;
  start_tag_count: number;
  end_tag_count: number;
  stats: {
    total_chunks: number;
    creations_started: number;
    creations_completed: number;
    outside_sections: number;
  };
  completed_at?: string;
}

interface StreamMonitorState {
  isMonitoring: boolean;
  creations: Record<string, CreationData>;
  outsideTexts: Record<string, OutsideCreationData>;
  lastUpdated: Date | null;
  error: string | null;
}

class StreamMonitor {
  private state: StreamMonitorState = {
    isMonitoring: false,
    creations: {},
    outsideTexts: {},
    lastUpdated: null,
    error: null
  };

  private callbacks: Array<(state: StreamMonitorState) => void> = [];
  private eventSource: EventSource | null = null;

  constructor() {
    console.log('🔧 StreamMonitor: Initialized with Server-Sent Events');
  }

  /**
   * Start monitoring using Server-Sent Events (real-time push notifications)
   */
  startMonitoring(): void {
    if (this.state.isMonitoring) {
      console.log('🔄 Stream monitor already running');
      return;
    }

    this.state.isMonitoring = true;
    console.log('🟢 StreamMonitor: Starting real-time monitoring with Server-Sent Events...');
    
    // Connect to Server-Sent Events endpoint
    this.connectToEventStream();
    
    this.notifyCallbacks();
  }

  /**
   * Connect to the Server-Sent Events stream
   */
  private connectToEventStream(): void {
    try {
      this.eventSource = new EventSource('/api/stream-events');

      this.eventSource.onopen = () => {
        console.log('📡 StreamMonitor: Connected to real-time event stream');
        this.state.error = null;
        this.notifyCallbacks();
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          switch (data.type) {
            case 'connected':
              console.log('✅ StreamMonitor: Event stream connection confirmed');
              break;
              
            case 'stream_updated':
              console.log('🔥 StreamMonitor: Real-time update received!');
              this.fetchLatestStreamData();
              break;
              
            case 'heartbeat':
              console.log('💓 StreamMonitor: Heartbeat received');
              break;
              
            case 'error':
              console.error('❌ StreamMonitor: Server error:', data.message);
              this.state.error = data.message;
              this.notifyCallbacks();
              break;
              
            default:
              console.log('📨 StreamMonitor: Unknown event type:', data.type);
          }
        } catch (error) {
          console.error('❌ StreamMonitor: Error parsing event data:', error);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('❌ StreamMonitor: Event stream error:', error);
        this.state.error = 'Connection to real-time stream failed';
        this.notifyCallbacks();
        
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (this.state.isMonitoring && (!this.eventSource || this.eventSource.readyState === EventSource.CLOSED)) {
            console.log('🔄 StreamMonitor: Attempting to reconnect...');
            this.connectToEventStream();
          }
        }, 5000);
      };

    } catch (error) {
      console.error('❌ StreamMonitor: Failed to create EventSource:', error);
      this.state.error = `Failed to connect to event stream: ${error}`;
      this.notifyCallbacks();
    }
  }

  /**
   * Fetch the latest stream data when notified of an update
   */
  private async fetchLatestStreamData(): Promise<void> {
    try {
      const response = await fetch('/api/stream-logs/latest');
      
      if (!response.ok) {
        if (response.status === 404) {
          // No stream logs available yet
          console.log('📝 StreamMonitor: No stream logs available yet');
          return;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: StreamLogData = await response.json();
      
      // Process creations
      const creations: Record<string, CreationData> = {};
      if (data.inside_creations) {
        Object.entries(data.inside_creations).forEach(([key, creation]) => {
          const creationData = creation as CreationData;
          creations[key] = {
            type: creationData.type || 'unknown',
            title: creationData.title || '',
            language: creationData.language,
            content: creationData.content || '',
            is_complete: creationData.is_complete || false,
            start_position: creationData.start_position || 0,
            end_position: creationData.end_position,
            start_tag: creationData.start_tag || '',
            end_tag: creationData.end_tag
          };
        });
      }

      // Process outside texts
      const outsideTexts: Record<string, OutsideCreationData> = {};
      if (data.outside_creations) {
        Object.entries(data.outside_creations).forEach(([key, outsideText]) => {
          const outsideData = outsideText as OutsideCreationData;
          outsideTexts[key] = {
            content: outsideData.content || '',
            is_active: outsideData.is_active || false,
            position: outsideData.position || 0,
            end_position: outsideData.end_position,
            after_creation: outsideData.after_creation,
            error: outsideData.error
          };
        });
      }

      // Update state
      this.state.creations = creations;
      this.state.outsideTexts = outsideTexts;
      this.state.lastUpdated = new Date();
      this.state.error = null;

      // Log update info
      const creationCount = Object.keys(creations).length;
      const outsideCount = Object.keys(outsideTexts).length;
      console.log(`🎉 StreamMonitor: Updated - ${creationCount} creations, ${outsideCount} outside texts`);

      // Notify callbacks
      this.notifyCallbacks();
    } catch (error) {
      console.error('❌ StreamMonitor: Error fetching stream data:', error);
      this.state.error = `Failed to fetch stream data: ${error}`;
      this.notifyCallbacks();
    }
  }

  /**
   * Stop monitoring and close the event stream
   */
  stopMonitoring(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      console.log('📡 StreamMonitor: Event stream closed');
    }
    
    this.state.isMonitoring = false;
    console.log('🛑 StreamMonitor: Real-time monitoring stopped');
    this.notifyCallbacks();
  }

  /**
   * Get current state
   */
  getState(): StreamMonitorState {
    return { ...this.state };
  }

  /**
   * Subscribe to state updates
   */
  onUpdate(callback: (state: StreamMonitorState) => void): () => void {
    this.callbacks.push(callback);
    // Return unsubscribe function
    return () => {
      const index = this.callbacks.indexOf(callback);
      if (index > -1) {
        this.callbacks.splice(index, 1);
      }
    };
  }

  /**
   * Notify all callbacks of state changes
   */
  private notifyCallbacks(): void {
    this.callbacks.forEach(callback => {
      try {
        callback(this.state);
      } catch (error) {
        console.error('❌ StreamMonitor: Error in callback:', error);
      }
    });
  }

  /**
   * Get a specific creation by ID
   */
  public getCreation(creationId: string): CreationData | undefined {
    return this.state.creations[creationId];
  }

  /**
   * Get a specific outside text by ID
   */
  public getOutsideText(outsideTextId: string): OutsideCreationData | undefined {
    return this.state.outsideTexts[outsideTextId];
  }

  /**
   * Get all creations as an array
   */
  public getAllCreations(): CreationData[] {
    return Object.values(this.state.creations);
  }

  /**
   * Get all outside texts as an array
   */
  public getAllOutsideTexts(): OutsideCreationData[] {
    return Object.values(this.state.outsideTexts);
  }
}

// Export singleton instance
export const streamMonitor = new StreamMonitor();
export type { StreamMonitorState, CreationData, OutsideCreationData }; 