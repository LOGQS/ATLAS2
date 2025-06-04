import { Creation } from './creationsHelper';

// Type definitions for the creation events
export type CreationEvent = 'add' | 'update' | 'remove' | 'view' | 'clear';
export type CreationListener = (event: CreationEvent, creation: Creation | null, allCreations: Creation[]) => void;

/**
 * Creation Manager - Singleton class to manage all creations throughout the application
 * Provides methods to add, retrieve, and manage creations with persistent storage
 */
class CreationManager {
  private static instance: CreationManager;
  private creations: Creation[] = [];
  private listeners: CreationListener[] = [];
  private creationHistory: string[] = []; // Store IDs of viewed creations in order
  
  // Track last view notification to avoid too many view events
  private lastViewNotification: { id: string, timestamp: number } | null = null;

  // Track backend availability and initialization status
  private backendAvailable: boolean = false;
  private initialLoadAttempted: boolean = false;
  private maxRetries: number = 3;
  private retryCount: number = 0;
  private retryTimeout: number | null = null;
  
  private constructor() {
    // Initialize storage and set up backend health check
    this.initializeStorage();
    this.checkBackendHealth();
  }
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): CreationManager {
    if (!CreationManager.instance) {
      CreationManager.instance = new CreationManager();
    }
    return CreationManager.instance;
  }

  /**
   * Check if the backend is available by making a health check request
   */
  private async checkBackendHealth(): Promise<void> {
    try {
      const response = await fetch('/api/health', {
        method: 'GET',
        headers: {
          'Cache-Control': 'no-cache'
        }
      }).catch(() => {
        // Silently catch connection errors
        return { ok: false } as Response;
      });

      this.backendAvailable = response.ok;
      console.log(`Backend health check: ${this.backendAvailable ? 'Available' : 'Unavailable'}`);

      // If backend is available now and we haven't successfully loaded the gallery yet,
      // try to load it
      if (this.backendAvailable && !this.initialLoadAttempted && this.creations.length === 0) {
        console.log('Backend is now available. Attempting to load gallery...');
        this.loadFromFileStorage()
          .then(() => {
            this.initialLoadAttempted = true;
            console.log('Gallery loaded successfully after backend became available');
          })
          .catch(error => {
            console.warn('Failed to load gallery after backend became available:', error);
            // Continue using session storage
          });
      }

      // If backend is still not available, set up another health check after a delay
      if (!this.backendAvailable && this.retryCount < this.maxRetries) {
        this.retryCount++;
        const retryDelay = Math.min(2000 * this.retryCount, 10000); // Exponential backoff, max 10 seconds
        console.log(`Will retry backend health check in ${retryDelay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
        
        // Clear any existing timeout
        if (this.retryTimeout !== null) {
          window.clearTimeout(this.retryTimeout);
        }
        
        // Set up a new timeout
        this.retryTimeout = window.setTimeout(() => {
          this.checkBackendHealth();
        }, retryDelay);
      }
    } catch (error) {
      console.error('Error checking backend health:', error);
      this.backendAvailable = false;
      
      // Retry health check with backoff
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        const retryDelay = Math.min(2000 * this.retryCount, 10000);
        console.log(`Will retry backend health check in ${retryDelay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
        
        if (this.retryTimeout !== null) {
          window.clearTimeout(this.retryTimeout);
        }
        
        this.retryTimeout = window.setTimeout(() => {
          this.checkBackendHealth();
        }, retryDelay);
      }
    }
  }
  
  /**
   * Initialize the storage system: create the data folder if it doesn't exist
   * and load any existing creations
   */
  private async initializeStorage(): Promise<void> {
    try {
      // Always check session storage first for immediate UI display
      this.loadFromSessionStorage();
      console.log(`Loaded ${this.creations.length} creations from session storage for immediate use`);
      
      // Try to load from file storage as well, but handle connection errors gracefully
      if (this.creations.length === 0) {
        try {
          // Initial attempt to load from backend
          await this.loadFromFileStorage();
          this.initialLoadAttempted = true;
        } catch (error) {
          // If it's a connection error, we'll try again when the backend is available
          if (error instanceof Error && error.message.includes('Backend not available')) {
            console.log('Backend not available yet. Will load gallery when backend is ready.');
          } else {
            console.error('Error loading from file storage:', error);
          }
        }
      }
    } catch (error) {
      console.error('Error initializing storage:', error);
    }
  }
  
  /**
   * Add a new creation to the manager
   */
  public addCreation(creation: Creation): Creation {
    // Add a unique ID if it doesn't exist
    const creationWithId = {
      ...creation,
      id: creation.id || `creation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };
    
    // Add to the creations list
    this.creations.push(creationWithId);
    
    // Save to session storage immediately
    this.saveToSessionStorage();
    
    // Only attempt to save to backend if it's available
    if (this.backendAvailable) {
      this.saveToFileStorage();
    }
    
    // Notify listeners
    this.notifyListeners('add', creationWithId, this.getCreations());
    
    return creationWithId;
  }
  
  /**
   * Get all creations
   */
  public getCreations(): Creation[] {
    return [...this.creations];
  }
  
  /**
   * Get creations by type
   */
  public getCreationsByType(type: string): Creation[] {
    return this.creations.filter(c => c.type === type);
  }
  
  /**
   * Get a creation by ID
   */
  public getCreationById(id: string): Creation | undefined {
    return this.creations.find(c => c.id === id);
  }
  
  /**
   * Record viewing a creation (adds to history)
   */
  public viewCreation(creationId: string): void {
    const creation = this.getCreationById(creationId);
    if (!creation) return;
    
    // Check if this is already the most recent in history
    if (this.creationHistory[this.creationHistory.length - 1] === creationId) {
      // Already the most recent, no need to update history or save
      return;
    }
    
    // Add to history if not already the most recent
    // Remove previous instances to avoid duplicates
    const previousLength = this.creationHistory.length;
    this.creationHistory = this.creationHistory.filter(id => id !== creationId);
    this.creationHistory.push(creationId);
    
    // Only save if the history actually changed
    if (this.creationHistory.length !== previousLength || 
        this.creationHistory[previousLength - 1] !== creationId) {
      // Save to session storage immediately
      this.saveToSessionStorage();

      // Only attempt to save to file storage if backend is available
      if (this.backendAvailable) {
        this.saveToFileStorage();
      }
    }
    
    // Always notify listeners of the view event
    this.notifyListeners('view', creation, this.getCreations());
  }
  
  /**
   * Get creation view history
   */
  public getViewHistory(): string[] {
    return [...this.creationHistory];
  }
  
  /**
   * Get most recently viewed creations
   */
  public getRecentCreations(limit: number = 5): Creation[] {
    const recentIds = this.creationHistory.slice(-limit).reverse();
    return recentIds
      .map(id => this.getCreationById(id))
      .filter((creation): creation is Creation => creation !== undefined);
  }
  
  /**
   * Clear all creations
   */
  public clearCreations(): void {
    this.creations = [];
    this.creationHistory = [];
    
    // Save empty state to session storage
    this.saveToSessionStorage();
    
    // Only attempt to save to file storage if backend is available
    if (this.backendAvailable) {
      this.saveToFileStorage();
    }
    
    this.notifyListeners('remove', {} as Creation, this.getCreations());
  }
  
  /**
   * Add a listener for creation changes
   */
  public subscribe(listener: CreationListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
  
  /**
   * Notify all listeners of a change
   */
  private notifyListeners(event: CreationEvent, creation: Creation | null, allCreations: Creation[]): void {
    // For view events, throttle notifications to prevent spam
    if (event === 'view' && creation) {
      const now = Date.now();
      
      // If we've recently notified about viewing this same creation, skip
      if (this.lastViewNotification && 
          this.lastViewNotification.id === creation.id &&
          now - this.lastViewNotification.timestamp < 500) { // 500ms debounce
        return;
      }
      
      // Update the last view notification
      this.lastViewNotification = {
        id: creation.id || '',
        timestamp: now
      };
    }
    
    // Notify all listeners
    this.listeners.forEach(listener => {
      try {
        listener(event, creation, allCreations);
      } catch (error) {
        console.error('Error in creation listener:', error);
      }
    });
  }
  
  /**
   * Save the current state to file storage
   */
  private saveToFileStorage(): void {
    try {
      const data = {
        creations: this.creations,
        history: this.creationHistory
      };
      
      // Only attempt to save if backend is confirmed available
      if (!this.backendAvailable) {
        console.log('Backend not available, saving to session storage only');
        return;
      }
      
      // Create a fetch request to the backend to save the data
      fetch('/api/gallery/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify(data),
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to save gallery: ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then(result => {
        console.log('Gallery saved successfully', result);
        // Backend is definitely available if save succeeded
        this.backendAvailable = true;
      })
      .catch(error => {
        console.error('Error saving gallery to file:', error);
        // Don't log connection errors as prominently since they're expected when backend is starting
        if (error.message && error.message.includes('Failed to fetch')) {
          console.log('Connection to backend failed, will use session storage for now');
          this.backendAvailable = false;
        }
      });
    } catch (error) {
      console.error('Error preparing gallery data for saving:', error);
      // Fallback to session storage on error
      this.saveToSessionStorage();
    }
  }
  
  /**
   * Load the state from file storage
   */
  private async loadFromFileStorage(): Promise<void> {
    try {
      console.log('Attempting to load gallery from backend API...');
      
      // Add error handling for potential ECONNREFUSED errors when the backend is starting up
      const response = await fetch('/api/gallery/load', {
        // Adding these options to handle connection issues more gracefully
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache'
        },
        // Set a timeout for the request
        signal: AbortSignal.timeout(3000) // 3 second timeout
      }).catch(error => {
        console.log('Gallery load connection error:', error.message);
        this.backendAvailable = false;
        throw new Error('Backend not available yet');
      });
      
      if (!response.ok) {
        // If file doesn't exist yet (404), that's not an error - just start with empty gallery
        if (response.status === 404) {
          console.log('No gallery file found, starting with empty gallery');
          this.backendAvailable = true; // Backend is available, just no gallery file yet
          return;
        }
        
        throw new Error(`Failed to load gallery: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data && data.creations) {
        const previousCount = this.creations.length;
        this.creations = data.creations || [];
        this.creationHistory = data.history || [];
        console.log(`Loaded ${this.creations.length} creations from file storage (previously had ${previousCount})`);
        
        // Log the creation types that were loaded
        const creationTypes = this.creations.map(c => c.type);
        const typeCount: {[key: string]: number} = {};
        creationTypes.forEach(type => {
          typeCount[type] = (typeCount[type] || 0) + 1;
        });
        console.log('Creation types loaded:', typeCount);
        
        // If we successfully loaded, mark backend as available
        this.backendAvailable = true;
        this.initialLoadAttempted = true;
      }
    } catch (error) {
      console.error('Error loading gallery from file:', error);
      
      // Check if it's a connection error and set backend availability accordingly
      if (error instanceof Error && 
          (error.message.includes('Failed to fetch') || 
           error.message.includes('Backend not available'))) {
        this.backendAvailable = false;
        throw new Error('Backend not available yet');
      }
      
      throw error; // Re-throw to allow fallback to session storage
    }
  }
  
  /**
   * Save the current state to session storage (as backup)
   */
  private saveToSessionStorage(): void {
    try {
      const data = {
        creations: this.creations,
        history: this.creationHistory
      };
      sessionStorage.setItem('atlas_creations', JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save creations to session storage:', error);
    }
  }
  
  /**
   * Load the state from session storage (as backup or migration)
   */
  private loadFromSessionStorage(): void {
    try {
      const data = sessionStorage.getItem('atlas_creations');
      if (data) {
        const parsed = JSON.parse(data);
        
        // Only load from session storage if we don't already have data
        // or if session storage has more creations
        if (this.creations.length === 0 || (parsed.creations && parsed.creations.length > this.creations.length)) {
          this.creations = parsed.creations || [];
          this.creationHistory = parsed.history || [];
          console.log(`Loaded ${this.creations.length} creations from session storage`);
        }
      }
    } catch (error) {
      console.error('Failed to load creations from session storage:', error);
    }
  }
  
  /**
   * Rename a creation by ID
   */
  public renameCreation(id: string, newTitle: string): boolean {
    const creation = this.getCreationById(id);
    if (!creation) return false;
    
    // Update the creation title
    creation.title = newTitle;
    
    // Save to session storage
    this.saveToSessionStorage();
    
    // Only save to file storage if backend is available
    if (this.backendAvailable) {
      this.saveToFileStorage();
    }
    
    // Notify listeners with the updated creation
    this.notifyListeners('update', creation, this.getCreations());
    
    console.log(`Creation renamed: ${id}`);

    return true;
  }

  /**
   * Update creation content or other fields by ID
   */
  public updateCreation(id: string, updates: Partial<Creation>): boolean {
    const creation = this.getCreationById(id);
    if (!creation) return false;

    Object.assign(creation, updates);

    // Save to session storage
    this.saveToSessionStorage();

    // Only save to file storage if backend is available
    if (this.backendAvailable) {
      this.saveToFileStorage();
    }

    // Notify listeners with the updated creation
    this.notifyListeners('update', creation, this.getCreations());

    console.log(`Creation updated: ${id}`);

    return true;
  }

  /**
   * Remove a creation by ID
   */
  public removeCreation(id: string): boolean {
    const index = this.creations.findIndex(c => c.id === id);
    if (index === -1) return false;
    
    // Store the creation for logging
    const removedCreation = this.creations[index];
    
    // Remove from creations array
    this.creations.splice(index, 1);
    
    // Also remove from history if it exists there
    this.creationHistory = this.creationHistory.filter(historyId => historyId !== id);
    
    // Save to session storage
    this.saveToSessionStorage();
    
    // Only save to file storage if backend is available
    if (this.backendAvailable) {
      this.saveToFileStorage();
    }
    
    // Notify listeners with the removed creation for proper cleanup
    this.notifyListeners('remove', removedCreation, this.getCreations());
    
    console.log(`Creation removed: ${id}`);
    
    return true;
  }
  
  /**
   * Clear all creations
   */
  public async clearAllCreations(): Promise<void> {
    // Store count for logging
    const count = this.creations.length;
    
    // Clear all creations
    this.creations = [];
    this.creationHistory = [];
    
    // Save to session storage
    this.saveToSessionStorage();
    
    // If backend is available, call the clear endpoint
    if (this.backendAvailable) {
      try {
        const response = await fetch('/api/gallery/clear', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        
        if (!response.ok) {
          console.error('Failed to clear gallery on backend:', response.status);
        } else {
          console.log('Gallery cleared on backend successfully');
        }
      } catch (error) {
        console.error('Error clearing gallery on backend:', error);
      }
    }
    
    // Notify listeners with null creation and empty array
    this.notifyListeners('clear', null, []);
    
    console.log(`All ${count} creations cleared`);
  }
}

// Export the singleton instance
const creationManager = CreationManager.getInstance();
export default creationManager; 