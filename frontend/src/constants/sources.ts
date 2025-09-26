import { SourceInclusionState } from '../utils/storage/BrowserStorage';

export type SourcePane = 'web' | 'local';

export type SourceNodeKind =
  | 'collection'
  | 'folder'
  | 'file'
  | 'page'
  | 'repository'
  | 'dataset'
  | 'feed'
  | 'media'
  | 'reference';

export type SourceTagCategory = 'modality' | 'format' | 'type' | 'structure';

export interface SourceTagDefinition {
  id: string;
  label: string;
  category: SourceTagCategory;
  description: string;
  accent: string;
  background: string;
  icon: string;
}

export interface SourceMetadata {
  lastSynced?: string;
  lastIndexed?: string;
  size?: string;
  itemCount?: number;
  status?: 'connected' | 'syncing' | 'stale' | 'disconnected';
  provider?: string;
  locationLabel?: string;
  linkDepth?: string;
}

export interface SourceNode {
  id: string;
  name: string;
  description?: string;
  kind: SourceNodeKind;
  origin: SourcePane;
  icon: string;
  tagIds: string[];
  modalities?: string[];
  link?: string;
  path?: string;
  metadata?: SourceMetadata;
  children?: SourceNode[];
}

export interface SourceCollections {
  web: SourceNode[];
  local: SourceNode[];
}

export interface SourceIndices {
  index: Map<string, SourceNode>;
  parentMap: Map<string, string | null>;
  nodesByPane: Record<SourcePane, string[]>;
}

export interface SourceStatistics {
  total: number;
  overrides: number;
  included: number;
  excluded: number;
}

export const SOURCE_TAGS: SourceTagDefinition[] = [
  {
    id: 'text',
    label: 'Text',
    category: 'modality',
    description: 'Articles, documentation, transcripts, and any written content.',
    accent: '#a0d7ff',
    background: 'rgba(160, 215, 255, 0.16)',
    icon: '📝'
  },
  {
    id: 'audio',
    label: 'Audio',
    category: 'modality',
    description: 'Podcasts, narration tracks, call recordings, sonic cues.',
    accent: '#ffd580',
    background: 'rgba(255, 213, 128, 0.18)',
    icon: '🎧'
  },
  {
    id: 'video',
    label: 'Video',
    category: 'modality',
    description: 'Livestreams, webinars, screencasts, motion assets.',
    accent: '#ff9fa5',
    background: 'rgba(255, 159, 165, 0.18)',
    icon: '🎬'
  },
  {
    id: 'image',
    label: 'Images',
    category: 'modality',
    description: 'Screenshots, diagrams, marketing assets, UI mocks.',
    accent: '#ffd6f5',
    background: 'rgba(255, 214, 245, 0.18)',
    icon: '🖼️'
  },
  {
    id: 'metadata',
    label: 'Metadata',
    category: 'modality',
    description: 'Structured descriptors, titles, captions, annotations.',
    accent: '#d2c7ff',
    background: 'rgba(210, 199, 255, 0.18)',
    icon: '🧾'
  },
  {
    id: 'transcript',
    label: 'Transcripts',
    category: 'modality',
    description: 'Generated speech-to-text content and captioning.',
    accent: '#b8ffc2',
    background: 'rgba(184, 255, 194, 0.16)',
    icon: '🗣️'
  },
  {
    id: 'code',
    label: 'Code',
    category: 'format',
    description: 'Source code files, scripts, and programmatic assets.',
    accent: '#9ef0b8',
    background: 'rgba(158, 240, 184, 0.16)',
    icon: '💻'
  },
  {
    id: 'dataset',
    label: 'Datasets',
    category: 'format',
    description: 'Tabular data, analytics exports, research datasets.',
    accent: '#ffc89b',
    background: 'rgba(255, 200, 155, 0.18)',
    icon: '📊'
  },
  {
    id: 'spreadsheet',
    label: 'Spreadsheets',
    category: 'format',
    description: 'Financial models, CSVs, Google Sheets, Excel files.',
    accent: '#c0f2ff',
    background: 'rgba(192, 242, 255, 0.18)',
    icon: '📈'
  },
  {
    id: 'presentation',
    label: 'Slides',
    category: 'format',
    description: 'Pitch decks, slide shows, keynote presentations.',
    accent: '#ffc7e8',
    background: 'rgba(255, 199, 232, 0.18)',
    icon: '📽️'
  },
  {
    id: 'pdf',
    label: 'PDF',
    category: 'format',
    description: 'Portable documents, manuals, signed agreements.',
    accent: '#ffc4a4',
    background: 'rgba(255, 196, 164, 0.18)',
    icon: '📄'
  },
  {
    id: 'markdown',
    label: 'Markdown',
    category: 'format',
    description: 'README files, technical notes, changelogs.',
    accent: '#d0ffe0',
    background: 'rgba(208, 255, 224, 0.18)',
    icon: '🪵'
  },
  {
    id: 'documentation',
    label: 'Documentation',
    category: 'type',
    description: 'Reference docs, product guides, onboarding manuals.',
    accent: '#8cd4ff',
    background: 'rgba(140, 212, 255, 0.16)',
    icon: '📚'
  },
  {
    id: 'tutorial',
    label: 'Tutorial',
    category: 'type',
    description: 'Step-by-step guides, walkthroughs, learning resources.',
    accent: '#ffe28b',
    background: 'rgba(255, 226, 139, 0.18)',
    icon: '🧭'
  },
  {
    id: 'reference',
    label: 'Reference',
    category: 'type',
    description: 'API references, specification sheets, cheat sheets.',
    accent: '#bbf7ff',
    background: 'rgba(187, 247, 255, 0.18)',
    icon: '🧮'
  },
  {
    id: 'news',
    label: 'News',
    category: 'type',
    description: 'Changelogs, announcements, product updates.',
    accent: '#ffd0b2',
    background: 'rgba(255, 208, 178, 0.18)',
    icon: '📰'
  },
  {
    id: 'community',
    label: 'Community',
    category: 'type',
    description: 'Forums, Q&A boards, public discussions.',
    accent: '#e0d4ff',
    background: 'rgba(224, 212, 255, 0.18)',
    icon: '🗨️'
  },
  {
    id: 'research',
    label: 'Research',
    category: 'type',
    description: 'Whitepapers, publications, benchmarking studies.',
    accent: '#dce8ff',
    background: 'rgba(220, 232, 255, 0.18)',
    icon: '🔬'
  },
  {
    id: 'codebase',
    label: 'Codebase',
    category: 'structure',
    description: 'Repositories, monorepos, source trees, vendor SDKs.',
    accent: '#b4f6c3',
    background: 'rgba(180, 246, 195, 0.18)',
    icon: '🧱'
  },
  {
    id: 'folder',
    label: 'Folder',
    category: 'structure',
    description: 'Hierarchical groupings and directory-level sources.',
    accent: '#e1f0ff',
    background: 'rgba(225, 240, 255, 0.18)',
    icon: '🗂️'
  },
  {
    id: 'feed',
    label: 'Feeds',
    category: 'structure',
    description: 'RSS feeds, change streams, data pipelines.',
    accent: '#ffd6d9',
    background: 'rgba(255, 214, 217, 0.18)',
    icon: '🔁'
  },
  {
    id: 'documentation-site',
    label: 'Doc Site',
    category: 'structure',
    description: 'Linked documentation portals and knowledge hubs.',
    accent: '#acf0ff',
    background: 'rgba(172, 240, 255, 0.18)',
    icon: '🕸️'
  },
  {
    id: 'api',
    label: 'API',
    category: 'type',
    description: 'Endpoints, SDK references, machine-readable specs.',
    accent: '#bde8ff',
    background: 'rgba(189, 232, 255, 0.18)',
    icon: '🔗'
  },
  {
    id: 'blog',
    label: 'Blog',
    category: 'type',
    description: 'Editorial content, product stories, highlight reels.',
    accent: '#ffd7be',
    background: 'rgba(255, 215, 190, 0.18)',
    icon: '✍️'
  },
  {
    id: 'video-platform',
    label: 'Video Platform',
    category: 'type',
    description: 'Hosted video channels with transcripts and assets.',
    accent: '#ffb2c6',
    background: 'rgba(255, 178, 198, 0.18)',
    icon: '📺'
  },
  {
    id: 'design-assets',
    label: 'Design Assets',
    category: 'type',
    description: 'Figma projects, exported assets, creative libraries.',
    accent: '#fcdcff',
    background: 'rgba(252, 220, 255, 0.18)',
    icon: '🎨'
  }
];

export const TAG_MAP = new Map(SOURCE_TAGS.map(tag => [tag.id, tag]));

export const SOURCE_COLLECTIONS: SourceCollections = {
  web: [
    {
      id: 'web-atlas-docs',
      name: 'Atlas Documentation Hub',
      description: 'Product documentation, tutorials, and API reference across the Atlas platform.',
      kind: 'collection',
      origin: 'web',
      icon: '🌐',
      link: 'https://docs.atlas.app',
      tagIds: ['documentation', 'reference', 'api', 'text', 'documentation-site', 'metadata'],
      metadata: {
        lastSynced: '2024-12-18T09:10:00Z',
        status: 'connected',
        provider: 'Atlas Cloud',
        linkDepth: '3 levels deep'
      },
      children: [
        {
          id: 'web-atlas-docs-guides',
          name: 'Product Guides',
          description: 'Onboarding flows, feature deep dives, and how-to tutorials.',
          kind: 'page',
          origin: 'web',
          icon: '📘',
          link: 'https://docs.atlas.app/guides',
          tagIds: ['tutorial', 'documentation', 'text', 'metadata'],
          metadata: {
            lastSynced: '2024-12-17T19:00:00Z',
            status: 'connected'
          },
          children: [
            {
              id: 'web-atlas-docs-guide-automations',
              name: 'Automation Cookbook',
              description: 'Library of automation templates and prebuilt workflows.',
              kind: 'page',
              origin: 'web',
              icon: '📙',
              link: 'https://docs.atlas.app/guides/automations',
              tagIds: ['tutorial', 'text', 'metadata'],
              metadata: {
                lastSynced: '2024-12-17T18:30:00Z',
                status: 'connected'
              }
            },
            {
              id: 'web-atlas-docs-guide-security',
              name: 'Security Playbook',
              description: 'Procedures for account hardening, SSO, RBAC, and data governance.',
              kind: 'page',
              origin: 'web',
              icon: '🛡️',
              link: 'https://docs.atlas.app/guides/security',
              tagIds: ['documentation', 'reference', 'text', 'metadata'],
              metadata: {
                lastSynced: '2024-12-17T13:50:00Z',
                status: 'connected'
              }
            }
          ]
        },
        {
          id: 'web-atlas-docs-api',
          name: 'API Reference',
          description: 'Endpoint reference with live schema definitions and SDK examples.',
          kind: 'page',
          origin: 'web',
          icon: '🧾',
          link: 'https://docs.atlas.app/reference',
          tagIds: ['api', 'reference', 'text', 'metadata', 'code'],
          metadata: {
            lastSynced: '2024-12-18T04:10:00Z',
            status: 'connected',
            provider: 'Stoplight'
          }
        },
        {
          id: 'web-atlas-docs-release-notes',
          name: 'Release Notes',
          description: 'Monthly release cadence with product highlights and bug fixes.',
          kind: 'page',
          origin: 'web',
          icon: '🗞️',
          link: 'https://docs.atlas.app/release-notes',
          tagIds: ['news', 'text', 'metadata'],
          metadata: {
            lastSynced: '2024-12-16T08:22:00Z',
            status: 'connected'
          }
        }
      ]
    },
    {
      id: 'web-openai-blog',
      name: 'OpenAI Research & Product Blog',
      description: 'Research papers, safety notes, and product change announcements.',
      kind: 'feed',
      origin: 'web',
      icon: '📰',
      link: 'https://openai.com/blog',
      tagIds: ['blog', 'news', 'research', 'text', 'metadata'],
      metadata: {
        lastSynced: '2024-12-15T16:05:00Z',
        status: 'syncing',
        provider: 'RSS Feed'
      },
      children: [
        {
          id: 'web-openai-blog-gpt-updates',
          name: 'GPT Platform Updates',
          description: 'API feature updates, deprecations, and migration guides.',
          kind: 'page',
          origin: 'web',
          icon: '🧠',
          link: 'https://openai.com/blog/tags/product',
          tagIds: ['news', 'api', 'text', 'metadata'],
          metadata: {
            lastSynced: '2024-12-15T15:30:00Z',
            status: 'syncing'
          }
        },
        {
          id: 'web-openai-blog-safety',
          name: 'Safety Systems Research',
          description: 'Alignment research, evaluation frameworks, and safety benchmarks.',
          kind: 'page',
          origin: 'web',
          icon: '🛟',
          link: 'https://openai.com/blog/tags/research',
          tagIds: ['research', 'text', 'metadata'],
          metadata: {
            lastSynced: '2024-12-12T21:17:00Z',
            status: 'stale'
          }
        }
      ]
    },
    {
      id: 'web-youtube-channel',
      name: 'Atlas Launch Event',
      description: 'Livestream recording with chapter markers, transcript, and assets.',
      kind: 'media',
      origin: 'web',
      icon: '📺',
      link: 'https://youtube.com/watch?v=atlas',
      tagIds: ['video', 'audio', 'image', 'transcript', 'metadata', 'video-platform'],
      metadata: {
        lastSynced: '2024-12-18T10:42:00Z',
        status: 'connected',
        provider: 'YouTube'
      },
      children: [
        {
          id: 'web-youtube-transcript',
          name: 'Auto-generated Transcript',
          description: 'Full transcript with speaker diarization and timestamps.',
          kind: 'reference',
          origin: 'web',
          icon: '🗒️',
          tagIds: ['transcript', 'text', 'metadata'],
          metadata: {
            lastSynced: '2024-12-18T10:45:00Z',
            status: 'connected'
          }
        },
        {
          id: 'web-youtube-chapters',
          name: 'Chapter Breakdown',
          description: 'Segment metadata, slides references, and resource links.',
          kind: 'reference',
          origin: 'web',
          icon: '🔖',
          tagIds: ['metadata', 'image', 'presentation'],
          metadata: {
            lastSynced: '2024-12-18T10:50:00Z',
            status: 'connected'
          }
        }
      ]
    }
  ],
  local: [
    {
      id: 'local-workspace',
      name: 'Atlas Workspace',
      description: 'Primary synced workspace with code, docs, and research.',
      kind: 'folder',
      origin: 'local',
      icon: '💾',
      path: '~/Atlas',
      tagIds: ['codebase', 'folder', 'text', 'image', 'metadata'],
      metadata: {
        lastIndexed: '2024-12-18T09:00:00Z',
        size: '2.3 GB',
        itemCount: 428,
        status: 'connected',
        locationLabel: 'MacBook Pro'
      },
      children: [
        {
          id: 'local-workspace-src',
          name: 'src',
          description: 'Application source code including services and UI.',
          kind: 'folder',
          origin: 'local',
          icon: '🗂️',
          path: '~/Atlas/src',
          tagIds: ['codebase', 'code', 'folder'],
          metadata: {
            size: '1.1 GB',
            itemCount: 187,
            lastIndexed: '2024-12-18T08:55:00Z',
            status: 'connected'
          },
          children: [
            {
              id: 'local-workspace-src-services',
              name: 'services',
              description: 'Backend services powering Atlas automation.',
              kind: 'folder',
              origin: 'local',
              icon: '🗂️',
              path: '~/Atlas/src/services',
              tagIds: ['code', 'folder', 'codebase'],
              metadata: {
                size: '540 MB',
                itemCount: 64,
                lastIndexed: '2024-12-17T23:00:00Z',
                status: 'connected'
              },
              children: [
                {
                  id: 'local-workspace-src-services-auth',
                  name: 'auth.service.ts',
                  description: 'Authentication flows, OAuth clients, and session middleware.',
                  kind: 'file',
                  origin: 'local',
                  icon: '💻',
                  path: '~/Atlas/src/services/auth.service.ts',
                  tagIds: ['code', 'text'],
                  metadata: {
                    size: '18 KB',
                    lastIndexed: '2024-12-17T22:50:00Z',
                    status: 'connected'
                  }
                },
                {
                  id: 'local-workspace-src-services-sync',
                  name: 'sync.service.ts',
                  description: 'File watching, delta syncing, and background indexers.',
                  kind: 'file',
                  origin: 'local',
                  icon: '💻',
                  path: '~/Atlas/src/services/sync.service.ts',
                  tagIds: ['code', 'text', 'metadata'],
                  metadata: {
                    size: '25 KB',
                    lastIndexed: '2024-12-17T22:44:00Z',
                    status: 'connected'
                  }
                }
              ]
            },
            {
              id: 'local-workspace-src-ui',
              name: 'ui',
              description: 'Frontend components, hooks, and experience layers.',
              kind: 'folder',
              origin: 'local',
              icon: '🗂️',
              path: '~/Atlas/src/ui',
              tagIds: ['code', 'folder', 'design-assets'],
              metadata: {
                size: '320 MB',
                itemCount: 89,
                lastIndexed: '2024-12-17T21:00:00Z',
                status: 'connected'
              }
            }
          ]
        },
        {
          id: 'local-workspace-docs',
          name: 'docs',
          description: 'Internal design docs, RFCs, and whitepapers.',
          kind: 'folder',
          origin: 'local',
          icon: '📂',
          path: '~/Atlas/docs',
          tagIds: ['documentation', 'markdown', 'pdf', 'research', 'folder'],
          metadata: {
            size: '680 MB',
            itemCount: 142,
            lastIndexed: '2024-12-18T07:40:00Z',
            status: 'connected'
          },
          children: [
            {
              id: 'local-workspace-docs-roadmap',
              name: '2025-roadmap.md',
              description: 'Initiatives, timelines, and product strategy notes.',
              kind: 'file',
              origin: 'local',
              icon: '📝',
              path: '~/Atlas/docs/2025-roadmap.md',
              tagIds: ['markdown', 'text', 'metadata'],
              metadata: {
                size: '12 KB',
                lastIndexed: '2024-12-18T07:34:00Z',
                status: 'connected'
              }
            },
            {
              id: 'local-workspace-docs-whitepaper',
              name: 'search-architecture.pdf',
              description: 'Architecture deep dive for the semantic search pipeline.',
              kind: 'file',
              origin: 'local',
              icon: '📄',
              path: '~/Atlas/docs/search-architecture.pdf',
              tagIds: ['pdf', 'research', 'text', 'metadata'],
              metadata: {
                size: '2.6 MB',
                lastIndexed: '2024-12-18T07:12:00Z',
                status: 'connected'
              }
            }
          ]
        },
        {
          id: 'local-workspace-design',
          name: 'design',
          description: 'Figma exports, marketing visuals, brand assets.',
          kind: 'folder',
          origin: 'local',
          icon: '🎨',
          path: '~/Atlas/design',
          tagIds: ['design-assets', 'image', 'presentation', 'folder'],
          metadata: {
            size: '510 MB',
            itemCount: 59,
            lastIndexed: '2024-12-16T18:10:00Z',
            status: 'stale'
          },
          children: [
            {
              id: 'local-workspace-design-brand',
              name: 'brand-guidelines.pdf',
              description: 'Color, typography, and illustration guidelines.',
              kind: 'file',
              origin: 'local',
              icon: '📘',
              path: '~/Atlas/design/brand-guidelines.pdf',
              tagIds: ['pdf', 'image', 'presentation'],
              metadata: {
                size: '8.4 MB',
                lastIndexed: '2024-12-16T18:08:00Z',
                status: 'stale'
              }
            },
            {
              id: 'local-workspace-design-social',
              name: 'social-launch-assets',
              description: 'Animated exports and promotional banners.',
              kind: 'folder',
              origin: 'local',
              icon: '🗂️',
              path: '~/Atlas/design/social-launch-assets',
              tagIds: ['image', 'video', 'presentation', 'folder'],
              metadata: {
                size: '132 MB',
                itemCount: 24,
                lastIndexed: '2024-12-16T17:54:00Z',
                status: 'stale'
              }
            }
          ]
        }
      ]
    },
    {
      id: 'local-external-research',
      name: 'External Research Drop',
      description: 'Research snapshots synced from shared drive for ongoing analyses.',
      kind: 'folder',
      origin: 'local',
      icon: '🧳',
      path: '~/Atlas/external-research',
      tagIds: ['dataset', 'pdf', 'research', 'folder'],
      metadata: {
        size: '860 MB',
        itemCount: 39,
        lastIndexed: '2024-12-10T09:30:00Z',
        status: 'stale',
        locationLabel: 'Dropbox Sync'
      },
      children: [
        {
          id: 'local-external-research-benchmarks',
          name: 'benchmark-results.csv',
          description: 'Regression metrics, dataset stats, and inference timings.',
          kind: 'file',
          origin: 'local',
          icon: '📈',
          path: '~/Atlas/external-research/benchmark-results.csv',
          tagIds: ['dataset', 'spreadsheet', 'text', 'metadata'],
          metadata: {
            size: '4.2 MB',
            lastIndexed: '2024-12-10T09:20:00Z',
            status: 'stale'
          }
        },
        {
          id: 'local-external-research-proposals',
          name: 'partner-proposals',
          description: 'Partner-supplied proposals and evaluation notes.',
          kind: 'folder',
          origin: 'local',
          icon: '🗂️',
          path: '~/Atlas/external-research/partner-proposals',
          tagIds: ['pdf', 'text', 'metadata', 'folder'],
          metadata: {
            size: '220 MB',
            itemCount: 12,
            lastIndexed: '2024-12-10T08:45:00Z',
            status: 'stale'
          }
        }
      ]
    }
  ]
};

export const buildSourceIndices = (collections: SourceCollections): SourceIndices => {
  const index = new Map<string, SourceNode>();
  const parentMap = new Map<string, string | null>();
  const nodesByPane: Record<SourcePane, string[]> = {
    web: [],
    local: []
  };

  const traverse = (nodes: SourceNode[], pane: SourcePane, parentId: string | null) => {
    nodes.forEach(node => {
      index.set(node.id, node);
      parentMap.set(node.id, parentId);
      nodesByPane[pane].push(node.id);
      if (node.children && node.children.length > 0) {
        traverse(node.children, pane, node.id);
      }
    });
  };

  traverse(collections.web, 'web', null);
  traverse(collections.local, 'local', null);

  return { index, parentMap, nodesByPane };
};

export const flattenNodes = (nodes: SourceNode[]): SourceNode[] => {
  const list: SourceNode[] = [];
  const visit = (nodeList: SourceNode[]) => {
    nodeList.forEach(node => {
      list.push(node);
      if (node.children) {
        visit(node.children);
      }
    });
  };
  visit(nodes);
  return list;
};

export const buildStatistics = (
  collections: SourceCollections,
  overrides: Record<string, SourceInclusionState>,
  stateMap: Map<string, SourceStateSnapshot>
): SourceStatistics => {
  const flattened = flattenNodes([...collections.web, ...collections.local]);
  let included = 0;
  let excluded = 0;

  flattened.forEach(node => {
    const snapshot = stateMap.get(node.id);
    if (!snapshot) {
      included += 1;
      return;
    }
    if (snapshot.effectiveState === 'excluded') {
      excluded += 1;
    } else {
      included += 1;
    }
  });

  return {
    total: flattened.length,
    overrides: Object.keys(overrides).length,
    included,
    excluded
  };
};

export type SourceVisualState = 'included' | 'excluded' | 'partial';

export interface SourceStateSnapshot {
  visualState: SourceVisualState;
  effectiveState: SourceInclusionState;
  explicitState?: SourceInclusionState;
}

export const buildStateMap = (
  collections: SourceCollections,
  overrides: Record<string, SourceInclusionState>
): Map<string, SourceStateSnapshot> => {
  const stateMap = new Map<string, SourceStateSnapshot>();

  const traverse = (
    node: SourceNode,
    inherited: SourceInclusionState
  ): SourceStateSnapshot => {
    const explicit = overrides[node.id];
    const effective = explicit ?? inherited;

    const childSnapshots = (node.children ?? []).map(child => traverse(child, effective));
    let visual: SourceVisualState = explicit ?? effective;

    if (childSnapshots.length > 0) {
      const childVisuals = new Set<SourceVisualState>();
      childSnapshots.forEach(childSnapshot => {
        childVisuals.add(childSnapshot.visualState);
      });

      if (explicit) {
        if (
          childSnapshots.some(
            child => child.visualState !== explicit && child.visualState !== 'partial'
          ) || childSnapshots.some(child => child.visualState === 'partial')
        ) {
          visual = 'partial';
        } else {
          visual = explicit;
        }
      } else if (childVisuals.size === 1) {
        const only = childVisuals.values().next().value as SourceVisualState;
        visual = only;
      } else {
        visual = 'partial';
      }
    }

    const snapshot: SourceStateSnapshot = {
      visualState: visual,
      effectiveState: effective,
      explicitState: explicit
    };
    stateMap.set(node.id, snapshot);
    return snapshot;
  };

  collections.web.forEach(node => traverse(node, 'included'));
  collections.local.forEach(node => traverse(node, 'included'));

  return stateMap;
};

