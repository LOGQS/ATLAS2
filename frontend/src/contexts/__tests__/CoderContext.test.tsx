import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CoderProvider, useCoderContext } from '../CoderContext';

jest.mock('../../utils/filePreloader', () => ({
  filePreloader: {
    preloadRelatedFiles: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../utils/core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const TestHarness: React.FC = () => {
  const { selectFile, currentDocument } = useCoderContext();

  return (
    <div>
      <button onClick={() => selectFile('src/index.ts')}>open-file</button>
      <div data-testid="doc-path">{currentDocument?.filePath ?? 'none'}</div>
    </div>
  );
};

describe('CoderContext', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('loads file content when selectFile is invoked', async () => {
    const fetchMock = jest
      .fn()
      // Initial workspace lookup
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          workspace_path: '/workspace',
          workspace_name: 'workspace',
        }),
      })
      // File tree
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          root: {
            name: 'workspace',
            path: '',
            type: 'directory',
            modified: new Date().toISOString(),
            children: [
              {
                name: 'src',
                path: 'src',
                type: 'directory',
                modified: new Date().toISOString(),
                children: [
                  {
                    name: 'index.ts',
                    path: 'src/index.ts',
                    type: 'file',
                    modified: new Date().toISOString(),
                  },
                ],
              },
            ],
          },
        }),
      })
      // Git status
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          is_git_repo: false,
          status: {},
        }),
      })
      // File contents
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          content: 'console.log(1);',
          language: 'javascript',
        }),
      })
      .mockResolvedValue({
        json: async () => ({ success: true }),
      });

    // @ts-ignore - allow test double
    global.fetch = fetchMock;

    render(
      <CoderProvider chatId="chat-1">
        <TestHarness />
      </CoderProvider>
    );

    // Wait for initial data loading (workspace + tree + git status)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByText('open-file'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    await waitFor(() => {
      expect(screen.getByTestId('doc-path').textContent).toBe('src/index.ts');
    });
  });
});
