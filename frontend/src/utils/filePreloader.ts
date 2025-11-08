/**
 * File Preloader - Intelligently preloads related files for Monaco IntelliSense
 */

interface FileCache {
  content: string;
  timestamp: number;
  language: string;
}

class FilePreloader {
  private cache: Map<string, FileCache> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 100; // Maximum cached files

  private setCacheEntry(filePath: string, cache: FileCache): FileCache {
    this.cache.set(filePath, cache);

    if (this.cache.size > this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    return cache;
  }

  primeCache(filePath: string, content: string, language: string): void {
    this.setCacheEntry(filePath, {
      content,
      language,
      timestamp: Date.now(),
    });
  }

  /**
   * Extract import paths from file content
   */
  private extractImports(content: string, language: string): string[] {
    const imports: string[] = [];

    if (language === 'typescript' || language === 'javascript') {
      // Match ES6 imports: import ... from '...'
      const es6ImportRegex = /import\s+.*?\s+from\s+['"](.+?)['"]/g;
      let match;
      while ((match = es6ImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // Match require: require('...')
      const requireRegex = /require\s*\(\s*['"](.+?)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // Match dynamic imports: import('...')
      const dynamicImportRegex = /import\s*\(\s*['"](.+?)['"]\s*\)/g;
      while ((match = dynamicImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }
    } else if (language === 'python') {
      // Match Python imports: from ... import / import ...
      const pythonImportRegex = /(?:from|import)\s+([\w.]+)/g;
      let match;
      while ((match = pythonImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }
    }

    return imports;
  }

  /**
   * Resolve relative import to absolute file path
   */
  private resolveImportPath(importPath: string, currentFilePath: string, workspaceRoot: string): string | null {
    // Skip node_modules and external packages
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null;
    }

    // Get directory of current file
    const currentDir = currentFilePath.split('/').slice(0, -1).join('/');

    // Resolve relative path
    let resolvedPath = importPath;
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const parts = currentDir.split('/');
      const importParts = importPath.split('/');

      for (const part of importParts) {
        if (part === '.') continue;
        if (part === '..') {
          parts.pop();
        } else {
          parts.push(part);
        }
      }

      resolvedPath = parts.join('/');
    }

    // Add extensions if not present
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', ''];
    for (const ext of extensions) {
      const pathWithExt = resolvedPath + ext;
      return pathWithExt;
    }

    return resolvedPath;
  }

  /**
   * Preload a file and cache it
   */
  async preloadFile(
    filePath: string,
    chatId: string,
    apiUrl: (path: string) => string
  ): Promise<FileCache | null> {
    // Check if already cached and still valid
    const cached = this.cache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached;
    }

    try {
      const response = await fetch(
        apiUrl(`/api/coder-workspace/file?chat_id=${chatId}&path=${encodeURIComponent(filePath)}`)
      );
      const data = await response.json();

      if (data.success) {
        const fileCache: FileCache = {
          content: data.content,
          timestamp: Date.now(),
          language: data.language,
        };

        return this.setCacheEntry(filePath, fileCache);
      }
    } catch (err) {
      console.warn('[FilePreloader] Failed to preload file:', filePath, err);
    }

    return null;
  }

  /**
   * Preload files imported by the given file
   */
  async preloadRelatedFiles(
    filePath: string,
    content: string,
    language: string,
    workspaceRoot: string,
    chatId: string,
    apiUrl: (path: string) => string
  ): Promise<void> {
    const imports = this.extractImports(content, language);

    // Preload imported files in parallel (up to 5 at a time to avoid overwhelming)
    const batchSize = 5;
    for (let i = 0; i < imports.length; i += batchSize) {
      const batch = imports.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (importPath) => {
          const resolvedPath = this.resolveImportPath(importPath, filePath, workspaceRoot);
          if (resolvedPath) {
            await this.preloadFile(resolvedPath, chatId, apiUrl);
          }
        })
      );
    }
  }

  /**
   * Get cached file content
   */
  getCached(filePath: string): FileCache | null {
    const cached = this.cache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached;
    }
    return null;
  }

  /**
   * Clear expired cache entries
   */
  clearExpired(): void {
    const now = Date.now();
    const entries = Array.from(this.cache.entries());
    for (const [path, cache] of entries) {
      if (now - cache.timestamp >= this.CACHE_DURATION) {
        this.cache.delete(path);
      }
    }
  }

  /**
   * Clear all cache
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
      entries: Array.from(this.cache.keys()),
    };
  }
}

// Singleton instance
export const filePreloader = new FilePreloader();

// Clear expired cache every minute
setInterval(() => {
  filePreloader.clearExpired();
}, 60 * 1000);
