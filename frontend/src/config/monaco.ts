import type * as monacoType from 'monaco-editor';

/**
 * Configure Monaco Editor TypeScript language services
 * This eliminates false errors and provides IntelliSense for React, TypeScript, and modern JS
 */
export const configureMonaco = (monaco: typeof monacoType) => {
  // Configure TypeScript compiler options
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    lib: ['es2020', 'dom', 'dom.iterable'],
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    esModuleInterop: true,
    jsx: monaco.languages.typescript.JsxEmit.React,
    reactNamespace: 'React',
    allowJs: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    strict: false, // Disable strict mode to reduce false errors
  });

  // Configure JavaScript compiler options similarly
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    lib: ['es2020', 'dom', 'dom.iterable'],
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    esModuleInterop: true,
    jsx: monaco.languages.typescript.JsxEmit.React,
    reactNamespace: 'React',
    allowJs: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
  });

  // Configure diagnostic options to reduce false errors
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [
      1375, // 'await' expressions are only allowed at the top level of a file
      1378, // Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022'
      2307, // Cannot find module (common for imports without type definitions)
      2304, // Cannot find name (when library types aren't loaded)
      2552, // Cannot find name (for JSX)
      2686, // 'React' refers to a UMD global
      7016, // Could not find a declaration file for module
    ],
  });

  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [
      1375,
      1378,
      2307,
      2304,
      2552,
      2686,
      7016,
    ],
  });

  // Set eager model sync to improve IntelliSense performance
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);

  // Add React type definitions
  const reactTypes = `
    declare namespace React {
      type ReactNode = any;
      type ReactElement = any;
      type FC<P = {}> = (props: P) => ReactElement | null;
      function useState<T>(initialState: T | (() => T)): [T, (newState: T) => void];
      function useEffect(effect: () => void | (() => void), deps?: any[]): void;
      function useCallback<T extends (...args: any[]) => any>(callback: T, deps: any[]): T;
      function useMemo<T>(factory: () => T, deps: any[]): T;
      function useRef<T>(initialValue: T): { current: T };
      function useContext<T>(context: any): T;
      function createContext<T>(defaultValue: T): any;
      interface HTMLAttributes<T> { [key: string]: any; }
      interface CSSProperties { [key: string]: any; }
    }

    declare global {
      namespace JSX {
        interface Element extends React.ReactElement<any, any> { }
        interface IntrinsicElements {
          [elemName: string]: any;
        }
      }
    }
  `;

  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    reactTypes,
    'file:///node_modules/@types/react/index.d.ts'
  );

  monaco.languages.typescript.javascriptDefaults.addExtraLib(
    reactTypes,
    'file:///node_modules/@types/react/index.d.ts'
  );

  // Add common Node.js globals
  const nodeGlobals = `
    declare const process: any;
    declare const __dirname: string;
    declare const __filename: string;
    declare const module: any;
    declare const exports: any;
    declare const require: any;
    declare const global: any;
  `;

  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    nodeGlobals,
    'file:///node_modules/@types/node/globals.d.ts'
  );

  monaco.languages.typescript.javascriptDefaults.addExtraLib(
    nodeGlobals,
    'file:///node_modules/@types/node/globals.d.ts'
  );

  // Configure editor theme enhancements
  monaco.editor.defineTheme('custom-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
    ],
    colors: {
      'editor.background': '#1E1E1E',
      'editor.foreground': '#D4D4D4',
      'editor.lineHighlightBackground': '#2A2A2A',
      'editorCursor.foreground': '#AEAFAD',
      'editor.selectionBackground': '#264F78',
    },
  });
};

/**
 * Get language from file extension
 */
export const getLanguageFromPath = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    // JavaScript / TypeScript
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',

    // Web
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    // Data
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',

    // Markdown & Text
    md: 'markdown',
    txt: 'plaintext',

    // Programming Languages
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',

    // Config
    dockerfile: 'dockerfile',
    gitignore: 'plaintext',
    env: 'plaintext',
  };

  return languageMap[ext || ''] || 'plaintext';
};

/**
 * Get additional file-specific type definitions based on imports
 */
export const getFileTypeDefinitions = async (
  monaco: typeof monacoType,
  content: string,
  filePath: string
): Promise<void> => {
  // Detect if file uses specific libraries and add their type definitions
  const hasReactImport = content.includes('react') || content.includes('React');

  // You can extend this to fetch actual type definitions from CDN
  // For now, we just ensure React types are present
  if (hasReactImport) {
    // React types are already added in configureMonaco
    // In a full implementation, you could fetch from unpkg.com/@types/react
  }

  // Add more library detection as needed (e.g., Express, Node.js, etc.)
};
