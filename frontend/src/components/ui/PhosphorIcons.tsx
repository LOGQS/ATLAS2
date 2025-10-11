import { Icon, IconProps } from '@iconify/react';

// Phosphor icon mappings matching bolt.diy's usage
export const PhosphorIcon = {
  File: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:file-duotone" {...props} />,
  FilePlus: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:file-plus" {...props} />,
  Folder: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:folder" {...props} />,
  FolderOpen: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:folder-open" {...props} />,
  FolderPlus: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:folder-plus" {...props} />,
  CaretRight: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:caret-right" {...props} />,
  CaretDown: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:caret-down" {...props} />,
  Circle: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:circle-fill" {...props} />,
  LockSimple: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:lock-simple" {...props} />,
  LockKeyOpen: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:lock-key-open" {...props} />,
  Trash: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:trash" {...props} />,
  MagnifyingGlass: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:magnifying-glass" {...props} />,
  FileSearch: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:file-search" {...props} />,
  Terminal: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:terminal" {...props} />,
  Code: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:code" {...props} />,
  GearSix: (props: Omit<IconProps, 'icon'>) => <Icon icon="ph:gear-six" {...props} />,
};
