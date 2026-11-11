// Ponto de entrada do explorador de arquivos e da lixeira. O App importa daqui e carrega '../styles/files.css'.
export { createFsApi, type FsApi, type FsClientLike } from './api';
export { FileExplorer, type FileExplorerProps, type ChangeSignal } from './FileExplorer';
export { TrashView, type TrashViewProps } from './TrashView';
export { FolderTree } from './FolderTree';
export * from './helpers';
