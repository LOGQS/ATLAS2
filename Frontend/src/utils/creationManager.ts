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
  
  // Track processed edits to prevent duplicates
  private processedEdits: Set<string> = new Set();
  
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
      id: creation.id || `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
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
   * Get the version number for a creation (V1, V2, V3, etc.)
   */
  public getCreationVersionInfo(creation: Creation): { version: number; isLatest: boolean; totalVersions: number } {
    if (!creation.title) {
      return { version: 1, isLatest: true, totalVersions: 1 };
    }

    // Get all creations with the same title
    const sameTitle = this.creations.filter(c => c.title?.toLowerCase() === creation.title?.toLowerCase());
    
    if (sameTitle.length === 1) {
      return { version: 1, isLatest: true, totalVersions: 1 };
    }

    // Sort by creation timestamp (from ID) and editedAt to determine version order
    const sortedVersions = sameTitle.sort((a, b) => {
      // First priority: original creation (no editedAt) comes first
      if (!a.metadata?.editedAt && b.metadata?.editedAt) return -1;
      if (a.metadata?.editedAt && !b.metadata?.editedAt) return 1;
      
      // If both have editedAt, sort by editedAt
      if (a.metadata?.editedAt && b.metadata?.editedAt && 
          typeof a.metadata.editedAt === 'string' && typeof b.metadata.editedAt === 'string') {
        return new Date(a.metadata.editedAt).getTime() - new Date(b.metadata.editedAt).getTime();
      }
      
      // If neither has editedAt, sort by ID timestamp
      const getTimestamp = (id: string) => {
        const match = id?.match(/creation-(\d+)-/);
        return match ? parseInt(match[1]) : 0;
      };
      
      return getTimestamp(a.id || '') - getTimestamp(b.id || '');
    });

    const versionIndex = sortedVersions.findIndex(c => c.id === creation.id);
    const version = versionIndex + 1;
    const isLatest = versionIndex === sortedVersions.length - 1;
    
    return { version, isLatest, totalVersions: sortedVersions.length };
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

  /** Get the LATEST creation by title (case insensitive) - returns the most recently created version */
  public getCreationByTitle(title: string): Creation | undefined {
    // Find all creations with this title
    const matchingCreations = this.creations.filter(c => c.title?.toLowerCase() === title.toLowerCase());
    
    if (matchingCreations.length === 0) {
      return undefined;
    }
    
    // Return the most recent one (highest timestamp in ID or latest editedAt)
    return matchingCreations.reduce((latest, current) => {
      // If current has editedAt and is more recent, use it
      if (current.metadata?.editedAt && latest.metadata?.editedAt && 
          typeof current.metadata.editedAt === 'string' && typeof latest.metadata.editedAt === 'string') {
        return new Date(current.metadata.editedAt) > new Date(latest.metadata.editedAt) ? current : latest;
      }
      
      // If only current has editedAt, it's newer
      if (current.metadata?.editedAt && !latest.metadata?.editedAt) {
        return current;
      }
      
      // If only latest has editedAt, it's newer
      if (!current.metadata?.editedAt && latest.metadata?.editedAt) {
        return latest;
      }
      
      // Neither has editedAt, compare by ID timestamp (extract timestamp from ID)
      const getCurrentTimestamp = () => {
        const match = current.id?.match(/creation-(\d+)-/);
        return match ? parseInt(match[1]) : 0;
      };
      
      const getLatestTimestamp = () => {
        const match = latest.id?.match(/creation-(\d+)-/);
        return match ? parseInt(match[1]) : 0;
      };
      
      return getCurrentTimestamp() > getLatestTimestamp() ? current : latest;
    });
  }

  /** Edit a creation's content by title - creates a new version instead of modifying the original */
  public editCreationByTitle(title: string, content: string, mode: 'replace' | 'append' = 'replace'): Creation | null {
    const originalCreation = this.getCreationByTitle(title);
    if (!originalCreation || !originalCreation.id) return null;

    // Create a unique key for this edit operation to prevent duplicates
    const editKey = `${title}-${mode}-${content.substring(0, 50)}-${Date.now()}`;
    
    // Check if this edit has already been processed recently (within last 1000ms)
    const recentEdits = Array.from(this.processedEdits).filter(key => {
      const timestamp = parseInt(key.split('-').pop() || '0');
      return Date.now() - timestamp < 1000; // Within last second
    });
    
    const isDuplicate = recentEdits.some(key => 
      key.startsWith(`${title}-${mode}`) && key.includes(content.substring(0, 50))
    );
    
    if (isDuplicate) {
      console.log(`Skipping duplicate edit for ${title} (${mode})`);
      // Return the most recent creation with this title
      return this.getCreationByTitle(title) || null;
    }

    // Create new content based on mode
    let newContent: string;
    if (mode === 'append') {
      // Ensure proper spacing when appending - add newline if original doesn't end with one
      const originalEndsWithNewline = originalCreation.content.endsWith('\n');
      const contentStartsWithNewline = content.startsWith('\n');
      
      if (originalEndsWithNewline || contentStartsWithNewline) {
        // Already has proper spacing
        newContent = originalCreation.content + content;
      } else {
        // Add newline between content
        newContent = originalCreation.content + '\n' + content;
      }
    } else {
      newContent = content;
    }
    
    // Create a new creation object (new version) instead of modifying the original
    const newCreation: Creation = {
      ...originalCreation,
      content: newContent,
      id: `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      metadata: {
        ...originalCreation.metadata,
        originalId: originalCreation.id,
        editMode: mode,
        editedAt: new Date().toISOString()
      }
    };
    
    // Add the new version to the gallery
    const addedCreation = this.addCreation(newCreation);
    
    // Track this edit to prevent duplicates
    this.processedEdits.add(editKey);
    
    // Clean up old edit keys (keep only last 100)
    if (this.processedEdits.size > 100) {
      const oldestKeys = Array.from(this.processedEdits).slice(0, 50);
      oldestKeys.forEach(key => this.processedEdits.delete(key));
    }
    
    console.log(`✅ [PATCH-COMPLETE] Successfully patched "${title}" - content changed from ${originalCreation.content.length} to ${newContent.length} chars`);
    
    // Return the new creation version
    return addedCreation;
  }

  /** Replace a specific snippet within a creation by title - creates a new version instead of modifying the original */
  public patchCreationByTitle(title: string, target: string, replacement: string): Creation | null {
    const originalCreation = this.getCreationByTitle(title);
    if (!originalCreation || !originalCreation.id) return null;

    // Create a unique key for this patch operation to prevent duplicates
    const patchKey = `${title}-patch-${target.substring(0, 20)}-${replacement.substring(0, 20)}-${Date.now()}`;
    
    // Check if this patch has already been processed recently (within last 1000ms)
    const recentPatches = Array.from(this.processedEdits).filter(key => {
      const timestamp = parseInt(key.split('-').pop() || '0');
      return Date.now() - timestamp < 1000; // Within last second
    });
    
    const isDuplicate = recentPatches.some(key => 
      key.startsWith(`${title}-patch`) && 
      key.includes(target.substring(0, 20)) && 
      key.includes(replacement.substring(0, 20))
    );
    
    if (isDuplicate) {
      console.log(`Skipping duplicate patch for ${title} (${target} -> ${replacement})`);
      // Return the most recent creation with this title
      return this.getCreationByTitle(title) || null;
    }

    // Enhanced replacement logic with multiple fallback strategies
    let newContent = originalCreation.content;
    let matched = false;
    
    // Strategy 1: Try exact match first
    if (originalCreation.content.includes(target)) {
      newContent = originalCreation.content.replace(target, replacement);
      matched = true;
      console.log(`✅ [PATCH-SUCCESS] Exact match found for "${target}" in "${title}"`);
    } else {
      console.log(`❌ [PATCH-FAIL] Exact match failed for target in "${title}":`, {
        target: JSON.stringify(target),
        targetLength: target.length,
        hasNewlines: target.includes('\n'),
        hasCarriageReturns: target.includes('\r'),
        contentPreview: originalCreation.content.substring(0, 200) + '...'
      });
      
      // Strategy 2: Try with normalized whitespace (convert all whitespace to single spaces)
      const normalizeWhitespace = (str: string) => str.replace(/\s+/g, ' ').trim();
      const normalizedTarget = normalizeWhitespace(target);
      const normalizedContent = normalizeWhitespace(originalCreation.content);
      
      if (normalizedContent.includes(normalizedTarget)) {
        // Find the original text that corresponds to the normalized target
        const words = normalizedTarget.split(' ');
        
        // Create a regex that matches the target with flexible whitespace
        const flexiblePattern = words.map(word => 
          word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ).join('\\s+');
        
        try {
          const flexibleRegex = new RegExp(flexiblePattern, 'g');
          if (flexibleRegex.test(originalCreation.content)) {
            newContent = originalCreation.content.replace(flexibleRegex, replacement);
            matched = true;
            console.log(`✅ [PATCH-SUCCESS] Flexible whitespace match found for "${target}" in "${title}"`);
          }
        } catch (error) {
          console.log(`⚠️ [PATCH-REGEX-ERROR] Flexible regex failed:`, error);
        }
      }
      
      // Strategy 3: Try removing all newlines and extra whitespace from both target and content
      if (!matched) {
        const cleanTarget = target.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = cleanTarget.split('\n').map(line => line.trim()).filter(line => line);
        
        if (lines.length === 1) {
          // Single line - try trimmed exact match
          const trimmedTarget = target.trim();
          if (originalCreation.content.includes(trimmedTarget)) {
            newContent = originalCreation.content.replace(trimmedTarget, replacement);
            matched = true;
            console.log(`✅ [PATCH-SUCCESS] Trimmed match found for "${target}" in "${title}"`);
          }
        } else if (lines.length > 1) {
          // Multi-line - try to find the pattern allowing for different line endings
          const multiLinePattern = lines.map(line => 
            line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          ).join('\\s*\\n\\s*');
          
          try {
            const multiLineRegex = new RegExp(multiLinePattern, 'g');
            if (multiLineRegex.test(originalCreation.content)) {
              newContent = originalCreation.content.replace(multiLineRegex, replacement);
              matched = true;
              console.log(`✅ [PATCH-SUCCESS] Multi-line pattern match found for "${target}" in "${title}"`);
            }
          } catch (error) {
            console.log(`⚠️ [PATCH-REGEX-ERROR] Multi-line regex failed:`, error);
          }
        }
      }
      
      // Strategy 4: Last resort - try regex matching
      if (!matched) {
        try {
          const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedTarget, 'g');
          if (regex.test(originalCreation.content)) {
            newContent = originalCreation.content.replace(regex, replacement);
            matched = true;
            console.log(`✅ [PATCH-SUCCESS] Regex match found for "${target}" in "${title}"`);
          }
        } catch (error) {
          console.log(`⚠️ [PATCH-REGEX-ERROR] Final regex attempt failed:`, error);
        }
      }
      
      // If still no match, log detailed failure information
      if (!matched) {
        console.error(`🚫 [PATCH-TOTAL-FAIL] All replacement strategies failed for "${title}":`, {
          originalTarget: JSON.stringify(target),
          targetChars: Array.from(target).map(c => c.charCodeAt(0)),
          contentLength: originalCreation.content.length,
          contentStart: JSON.stringify(originalCreation.content.substring(0, 100)),
          possibleMatches: [
            originalCreation.content.includes(target.trim()),
            originalCreation.content.includes(target.replace(/\n/g, ' ')),
            originalCreation.content.includes(target.replace(/\s+/g, ' '))
          ]
        });
        
        // Return the original creation unchanged if no replacement was possible
        return originalCreation;
      }
    }
    
    // Only create new version if content actually changed
    if (newContent === originalCreation.content) {
      console.log(`ℹ️ [PATCH-NO-CHANGE] No changes made to "${title}" - content remained the same`);
      return originalCreation;
    }
    
    // Create a new creation object (new version) instead of modifying the original
    const newCreation: Creation = {
      ...originalCreation,
      content: newContent,
      id: `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      metadata: {
        ...originalCreation.metadata,
        originalId: originalCreation.id,
        editMode: 'patch',
        patchTarget: target,
        patchReplacement: replacement,
        editedAt: new Date().toISOString()
      }
    };
    
    // Add the new version to the gallery
    const addedCreation = this.addCreation(newCreation);
    
    // Track this patch to prevent duplicates
    this.processedEdits.add(patchKey);
    
    // Clean up old edit keys (keep only last 100)
    if (this.processedEdits.size > 100) {
      const oldestKeys = Array.from(this.processedEdits).slice(0, 50);
      oldestKeys.forEach(key => this.processedEdits.delete(key));
    }
    
    // Return the new creation version
    return addedCreation;
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