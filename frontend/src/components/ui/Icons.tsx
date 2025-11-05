// Icon components using react-icons
import React from 'react';
import { IconBaseProps } from 'react-icons';
import {
  VscFiles,
  VscSearch,
  VscRefresh,
  VscClose,
  VscSave,
  VscDiscard,
  VscChevronDown,
  VscChevronRight,
  VscChevronLeft,
  VscFolder,
  VscFolderOpened,
  VscFile,
  VscTerminal,
  VscNewFile,
  VscNewFolder,
  VscTrash,
  VscEdit,
  VscCircleFilled,
  VscFileCode,
  VscJson,
  VscMarkdown,
  VscFilePdf,
  VscFileMedia,
  VscSettingsGear,
  VscHistory,
  VscWatch,
  VscCheck,
  VscAdd,
  VscFlame,
  VscRocket,
  VscInfo,
  VscEye,
  VscComment,
  VscCode,
  VscPulse,
  VscChecklist,
  VscAccount,
  VscHubot,
  VscSymbolKeyword,
  VscDebugRestart,
  VscBook,
  VscShield,
  VscLightbulb,
  VscPassFilled,
  VscSourceControl,
  VscDebugStepBack,
  VscDebugStepOver,
  VscPlay,
} from 'react-icons/vsc';
import {
  SiJavascript,
  SiTypescript,
  SiReact,
  SiPython,
  SiHtml5,
  SiCss3,
  SiNodedotjs,
  SiRust,
  SiGo,
  SiOpenjdk,
  SiRuby,
  SiPhp,
  SiDotnet,
  SiVuedotjs,
} from 'react-icons/si';

// Type for icon components
type IconComponent = React.FC<IconBaseProps>;

// Create wrapper components to fix TypeScript JSX issues
const createIconComponent = (IconComponent: any): IconComponent => {
  return (props: IconBaseProps) => <IconComponent {...props} />;
};

export const Icons = {
  // Navigation
  Files: createIconComponent(VscFiles),
  Search: createIconComponent(VscSearch),
  Refresh: createIconComponent(VscRefresh),
  Close: createIconComponent(VscClose),
  Terminal: createIconComponent(VscTerminal),
  Settings: createIconComponent(VscSettingsGear),
  History: createIconComponent(VscHistory),
  Clock: createIconComponent(VscWatch),
  Time: createIconComponent(VscWatch),
  Info: createIconComponent(VscInfo),
  Eye: createIconComponent(VscEye),

  // Actions
  Save: createIconComponent(VscSave),
  Discard: createIconComponent(VscDiscard),
  NewFile: createIconComponent(VscNewFile),
  NewFolder: createIconComponent(VscNewFolder),
  Delete: createIconComponent(VscTrash),
  Edit: createIconComponent(VscEdit),
  Check: createIconComponent(VscCheck),
  CheckCircle: createIconComponent(VscPassFilled),
  Add: createIconComponent(VscAdd),
  Zap: createIconComponent(VscFlame),
  Rocket: createIconComponent(VscRocket),
  Undo: createIconComponent(VscDebugRestart),
  Play: createIconComponent(VscPlay),
  SkipBack: createIconComponent(VscDebugStepBack),
  SkipForward: createIconComponent(VscDebugStepOver),

  // File Tree
  ChevronDown: createIconComponent(VscChevronDown),
  ChevronRight: createIconComponent(VscChevronRight),
  ChevronLeft: createIconComponent(VscChevronLeft),
  Back: createIconComponent(VscChevronLeft),
  Folder: createIconComponent(VscFolder),
  FolderOpen: createIconComponent(VscFolderOpened),
  File: createIconComponent(VscFile),
  Circle: createIconComponent(VscCircleFilled),

  // File Types
  FileCode: createIconComponent(VscFileCode),
  JavaScript: createIconComponent(SiJavascript),
  TypeScript: createIconComponent(SiTypescript),
  React: createIconComponent(SiReact),
  Python: createIconComponent(SiPython),
  HTML: createIconComponent(SiHtml5),
  CSS: createIconComponent(SiCss3),
  Json: createIconComponent(VscJson),
  Markdown: createIconComponent(VscMarkdown),
  Pdf: createIconComponent(VscFilePdf),
  Media: createIconComponent(VscFileMedia),

  // Languages/Technologies
  NodeJS: createIconComponent(SiNodedotjs),
  Rust: createIconComponent(SiRust),
  Go: createIconComponent(SiGo),
  Java: createIconComponent(SiOpenjdk),
  Ruby: createIconComponent(SiRuby),
  PHP: createIconComponent(SiPhp),
  CSharp: createIconComponent(SiDotnet),
  Vue: createIconComponent(SiVuedotjs),

  // Communication
  Chat: createIconComponent(VscComment),
  MessageCircle: createIconComponent(VscComment),
  Send: createIconComponent(VscSymbolKeyword),
  User: createIconComponent(VscAccount),
  Bot: createIconComponent(VscHubot),
  Paperclip: createIconComponent(VscSymbolKeyword),

  // Code & Development
  Code: createIconComponent(VscCode),
  Activity: createIconComponent(VscPulse),
  List: createIconComponent(VscChecklist),
  GitBranch: createIconComponent(VscSourceControl),

  // Learning & Knowledge
  Book: createIconComponent(VscBook),
  Shield: createIconComponent(VscShield),
  Lightbulb: createIconComponent(VscLightbulb),
};

export const getFileIcon = (fileName: string): IconComponent => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const name = fileName.toLowerCase();

  // Special file names (exact match)
  const specialFiles: Record<string, IconComponent> = {
    'package.json': Icons.NodeJS,
    'tsconfig.json': Icons.TypeScript,
    'dockerfile': Icons.FileCode,
    '.dockerignore': Icons.FileCode,
    '.gitignore': Icons.FileCode,
    '.env': Icons.FileCode,
    '.env.local': Icons.FileCode,
    '.env.development': Icons.FileCode,
    '.env.production': Icons.FileCode,
    'readme.md': Icons.Markdown,
    'cargo.toml': Icons.Rust,
    'go.mod': Icons.Go,
    'go.sum': Icons.Go,
    'gemfile': Icons.Ruby,
    'composer.json': Icons.PHP,
  };

  if (specialFiles[name]) {
    return specialFiles[name];
  }

  const iconMap: Record<string, IconComponent> = {
    // JavaScript / TypeScript
    'js': Icons.JavaScript,
    'mjs': Icons.JavaScript,
    'cjs': Icons.JavaScript,
    'jsx': Icons.React,
    'ts': Icons.TypeScript,
    'mts': Icons.TypeScript,
    'cts': Icons.TypeScript,
    'tsx': Icons.React,

    // Python
    'py': Icons.Python,
    'pyw': Icons.Python,
    'pyx': Icons.Python,

    // Web
    'html': Icons.HTML,
    'htm': Icons.HTML,
    'css': Icons.CSS,
    'scss': Icons.CSS,
    'sass': Icons.CSS,
    'less': Icons.CSS,

    // Data
    'json': Icons.Json,
    'jsonc': Icons.Json,
    'json5': Icons.Json,
    'yaml': Icons.FileCode,
    'yml': Icons.FileCode,
    'toml': Icons.FileCode,
    'xml': Icons.FileCode,
    'csv': Icons.FileCode,

    // Documentation
    'md': Icons.Markdown,
    'mdx': Icons.Markdown,
    'markdown': Icons.Markdown,
    'txt': Icons.FileCode,
    'pdf': Icons.Pdf,

    // Images
    'png': Icons.Media,
    'jpg': Icons.Media,
    'jpeg': Icons.Media,
    'gif': Icons.Media,
    'svg': Icons.Media,
    'ico': Icons.Media,
    'webp': Icons.Media,
    'bmp': Icons.Media,

    // Other languages
    'rs': Icons.Rust,
    'go': Icons.Go,
    'java': Icons.Java,
    'rb': Icons.Ruby,
    'php': Icons.PHP,
    'cs': Icons.CSharp,
    'cpp': Icons.FileCode,
    'c': Icons.FileCode,
    'h': Icons.FileCode,
    'hpp': Icons.FileCode,
    'swift': Icons.FileCode,
    'kt': Icons.FileCode,
    'scala': Icons.FileCode,

    // Config files
    'config': Icons.Settings,
    'conf': Icons.Settings,
    'ini': Icons.Settings,
    'env': Icons.Settings,

    // Shell scripts
    'sh': Icons.Terminal,
    'bash': Icons.Terminal,
    'zsh': Icons.Terminal,
    'fish': Icons.Terminal,
    'ps1': Icons.Terminal,
    'bat': Icons.Terminal,
    'cmd': Icons.Terminal,
  };

  return iconMap[ext || ''] || Icons.FileCode;
};

export const getProjectTypeIcon = (projectType: string): IconComponent => {
  const typeMap: Record<string, IconComponent> = {
    'React/TypeScript': Icons.React,
    'Vue.js': Icons.Vue,
    'Node.js': Icons.NodeJS,
    'Node.js/Express': Icons.NodeJS,
    'Python': Icons.Python,
    'Rust': Icons.Rust,
    'Go': Icons.Go,
    'Java': Icons.Java,
    'Ruby': Icons.Ruby,
    'PHP': Icons.PHP,
    'C#/.NET': Icons.CSharp,
    'Mixed': Icons.FileCode,
    'Unknown': Icons.Folder,
  };

  return typeMap[projectType] || Icons.Folder;
};
