import * as monaco from 'monaco-editor';
import type { CoderStreamSegment } from '../chat/LiveStore';
import logger from '../core/logger';

export interface StreamingDiffData {
  toolCallId: string;
  filePath: string;
  editMode: 'find_replace' | 'line_range' | 'file_write';
  findText?: string;
  replaceText?: string;
  startLine?: number;
  endLine?: number;
  newContent?: string;
  decorations: monaco.editor.IModelDeltaDecoration[];
}

interface ToolParams {
  file_path?: string;
  edit_mode?: string;
  find_text?: string;
  replace_text?: string;
  start_line?: string;
  end_line?: string;
  new_content?: string;
  content?: string;
}

/**
 * Compute streaming diff decorations from a tool call segment as parameters arrive.
 * Shows red highlights for text being removed and green inline previews for replacements.
 * For file.write, shows all content as green additions.
 */
export function computeStreamingDiff(
  toolCall: Extract<CoderStreamSegment, { type: 'tool_call' }>,
  fileContent: string
): StreamingDiffData | null {
  // Extract params into object
  const params: ToolParams = {};
  for (const param of toolCall.params) {
    params[param.name as keyof ToolParams] = param.value;
  }

  const filePath = params.file_path;
  if (!filePath) {
    return null;
  }

  // Handle file.write - show all content as green additions
  if (toolCall.tool === 'file.write') {
    logger.debug('[STREAMING_DIFF] Computing file.write diff for', filePath);
    return computeFileWriteDecorations(toolCall, params, filePath);
  }

  // Handle file.edit
  const editMode = (params.edit_mode || 'find_replace') as 'find_replace' | 'line_range';
  logger.debug('[STREAMING_DIFF] Computing file.edit diff for', filePath, 'mode:', editMode);

  if (editMode === 'find_replace') {
    return computeFindReplaceDecorations(toolCall, params, fileContent, filePath);
  } else if (editMode === 'line_range') {
    return computeLineRangeDecorations(toolCall, params, fileContent, filePath);
  }

  return null;
}

function computeFileWriteDecorations(
  toolCall: Extract<CoderStreamSegment, { type: 'tool_call' }>,
  params: ToolParams,
  filePath: string
): StreamingDiffData | null {
  const content = params.content;

  // Need content param to show something
  if (!content) {
    logger.debug('[STREAMING_DIFF] No content yet for file.write');
    return null;
  }

  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const lines = content.split('\n');

  // Show each line as a green addition
  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    decorations.push({
      range: new monaco.Range(lineNumber, 1, lineNumber, Math.max(1, line.length + 1)),
      options: {
        className: 'streaming-diff__line-add',
        isWholeLine: true,
        linesDecorationsClassName: 'streaming-diff__gutter-add',
      },
    });
  });

  logger.debug('[STREAMING_DIFF] Created', decorations.length, 'line decorations for file.write');

  return {
    toolCallId: toolCall.id,
    filePath,
    editMode: 'file_write',
    newContent: content,
    decorations,
  };
}

function computeFindReplaceDecorations(
  toolCall: Extract<CoderStreamSegment, { type: 'tool_call' }>,
  params: ToolParams,
  fileContent: string,
  filePath: string
): StreamingDiffData | null {
  const findText = params.find_text;
  const replaceText = params.replace_text;

  // Need at least find_text to show something
  if (!findText) {
    return null;
  }

  const lines = fileContent.split('\n');
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (line.includes(findText)) {
      // Red background for lines containing text to be removed
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, line.length + 1),
        options: {
          className: 'streaming-diff__line-remove',
          isWholeLine: true,
          linesDecorationsClassName: 'streaming-diff__gutter-remove',
        },
      });

      // If replaceText is available, show green inline preview
      if (replaceText !== undefined) {
        const startCol = line.indexOf(findText) + 1;
        const endCol = startCol + findText.length;

        // Show the new text as an inline decoration
        decorations.push({
          range: new monaco.Range(lineNumber, endCol, lineNumber, endCol),
          options: {
            after: {
              content: replaceText,
              inlineClassName: 'streaming-diff__inline-add',
            },
          },
        });

        // Strike through the old text
        decorations.push({
          range: new monaco.Range(lineNumber, startCol, lineNumber, endCol),
          options: {
            inlineClassName: 'streaming-diff__inline-strikethrough',
          },
        });
      }
    }
  });

  return {
    toolCallId: toolCall.id,
    filePath,
    editMode: 'find_replace',
    findText,
    replaceText,
    decorations,
  };
}

function computeLineRangeDecorations(
  toolCall: Extract<CoderStreamSegment, { type: 'tool_call' }>,
  params: ToolParams,
  fileContent: string,
  filePath: string
): StreamingDiffData | null {
  const startLineStr = params.start_line;
  const endLineStr = params.end_line;
  const newContent = params.new_content;

  // Need at least line range to show something
  if (!startLineStr || !endLineStr) {
    return null;
  }

  const startLine = parseInt(startLineStr, 10);
  const endLine = parseInt(endLineStr, 10);

  if (isNaN(startLine) || isNaN(endLine)) {
    return null;
  }

  const decorations: monaco.editor.IModelDeltaDecoration[] = [];

  // Highlight lines being replaced with red
  decorations.push({
    range: new monaco.Range(startLine, 1, endLine, Number.MAX_VALUE),
    options: {
      className: 'streaming-diff__line-remove',
      isWholeLine: true,
      linesDecorationsClassName: 'streaming-diff__gutter-remove',
    },
  });

  // If new content available, show preview
  if (newContent !== undefined) {
    // Show new content as "after" decoration on the end line
    decorations.push({
      range: new monaco.Range(endLine, Number.MAX_VALUE, endLine, Number.MAX_VALUE),
      options: {
        after: {
          content: `\n${newContent}`,
          inlineClassName: 'streaming-diff__block-add',
        },
      },
    });
  }

  return {
    toolCallId: toolCall.id,
    filePath,
    editMode: 'line_range',
    startLine,
    endLine,
    newContent,
    decorations,
  };
}

/**
 * Check if a file path matches the streaming diff
 */
export function isStreamingDiffForFile(
  diff: StreamingDiffData | null,
  filePath: string
): boolean {
  if (!diff) {
    return false;
  }

  // Normalize paths for comparison (handle both forward and backslashes)
  const normalizedDiffPath = diff.filePath.replace(/\\/g, '/').toLowerCase();
  const normalizedFilePath = filePath.replace(/\\/g, '/').toLowerCase();

  return normalizedDiffPath === normalizedFilePath ||
         normalizedDiffPath.endsWith(normalizedFilePath) ||
         normalizedFilePath.endsWith(normalizedDiffPath);
}
