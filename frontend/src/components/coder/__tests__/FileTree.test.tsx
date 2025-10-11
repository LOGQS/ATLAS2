import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from '../FileTree';

jest.mock('@iconify/react', () => ({
  Icon: ({ children }: { children?: React.ReactNode }) => <span>{children ?? null}</span>,
}));

jest.mock('react-virtualized-auto-sizer', () => ({
  __esModule: true,
  default: ({ children }: { children: (size: { height: number; width: number }) => React.ReactNode }) =>
    children({ height: 600, width: 300 }),
}));

jest.mock('../../../contexts/CoderContext', () => ({
  useCoderContext: jest.fn(),
}));

const mockUseCoderContext = require('../../../contexts/CoderContext')
  .useCoderContext as jest.Mock;

const baseContextValue = {
  expandedFolders: new Set<string>(['src']),
  selectedFile: undefined,
  activeTabPath: undefined,
  unsavedFiles: new Set<string>(),
  searchQuery: '',
  creatingNode: null,
  multiSelectedFiles: new Set<string>(),
  isGitRepo: false,
  gitStatus: {} as Record<string, 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'>,
  toggleFolder: jest.fn(),
  selectFile: jest.fn(),
  selectNode: jest.fn(),
  toggleMultiSelect: jest.fn(),
  clearMultiSelect: jest.fn(),
  deleteMultipleNodes: jest.fn(),
  cancelCreating: jest.fn(),
  finishCreating: jest.fn(),
  deleteNode: jest.fn(),
  renameNode: jest.fn(),
};

describe('FileTree', () => {
  beforeAll(() => {
    class ResizeObserver {
      observe() {
        return null;
      }
      unobserve() {
        return null;
      }
      disconnect() {
        return null;
      }
    }
    // jsdom doesn't provide ResizeObserver
    // @ts-ignore - polyfill for test environment
    global.ResizeObserver = ResizeObserver;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invokes selectFile when a file node is clicked', async () => {
    const selectFile = jest.fn().mockResolvedValue(undefined);

    mockUseCoderContext.mockReturnValue({
      ...baseContextValue,
      selectFile,
      fileTree: {
        name: 'workspace',
        path: '',
        type: 'directory' as const,
        modified: new Date().toISOString(),
        children: [
          {
            name: 'src',
            path: 'src',
            type: 'directory' as const,
            modified: new Date().toISOString(),
            children: [
              {
                name: 'index.ts',
                path: 'src/index.ts',
                type: 'file' as const,
                modified: new Date().toISOString(),
              },
            ],
          },
        ],
      },
      renamingPath: null,
      renameValue: '',
      renameInputRef: { current: null },
      setRenameValue: jest.fn(),
      handleRenameKeyDown: jest.fn(),
      handleRenameBlur: jest.fn(),
    });

    render(<FileTree />);

    const fileNode = await screen.findByText('index.ts');
    fireEvent.click(fileNode);

    await waitFor(() => {
      expect(selectFile).toHaveBeenCalledWith('src/index.ts');
    });
  });
});
