// Ponto de entrada do painel: componentes de apresentação pura + helpers. O App injeta as props (ver types.ts).
export * from './types';
export * from './helpers';
export { ChatView, Markdown } from './ChatView';
export { Composer } from './Composer';
export { ActivityTimeline } from './ActivityTimeline';
export { FilesPanel, gitStatusLabel } from './FilesPanel';
export { DeliverablesPanel, PreviewPane } from './DeliverablesPanel';
export { Sidebar } from './Sidebar';
export { WorkerPanel } from './WorkerPanel';
export { StatusBar } from './StatusBar';
export { Modal, Field } from './dialogs/Modal';
export { NewSessionDialog } from './dialogs/NewSessionDialog';
export { AddProjectDialog } from './dialogs/AddProjectDialog';
export { RoomEditor } from './dialogs/RoomEditor';
export { SettingsDialog } from './dialogs/SettingsDialog';
export { ToolIcon } from './icons';
