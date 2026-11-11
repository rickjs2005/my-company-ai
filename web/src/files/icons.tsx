// Ícones SVG inline do explorador (pasta, arquivo por tipo, chevron, ações). Herdam a cor do texto.
import type { FileKind } from './helpers';

interface P { size?: number; className?: string; title?: string }

function Svg({ size = 16, className, title, children }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const IconFolder = (p: P) => <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>;
export const IconFolderOpen = (p: P) => <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H6l-3 8z" /><path d="M3 18l3-8h17l-3 8z" /></Svg>;
export const IconFile = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>;
export const IconFileCode = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M10 13l-2 2 2 2" /><path d="M14 13l2 2-2 2" /></Svg>;
export const IconFileText = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h6" /></Svg>;
export const IconFileImage = (p: P) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="M20 16l-5-5-7 7" /></Svg>;
export const IconFileData = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 12h6M9 15h6M9 18h3" /></Svg>;
export const IconArchive = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></Svg>;
export const IconMedia = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M10 9l5 3-5 3z" /></Svg>;
export const IconBinary = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 14h.01M12 14h.01M15 14h.01" /></Svg>;
export const IconLink = (p: P) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><polyline points="9 6 15 12 9 18" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Svg>;
export const IconRefresh = (p: P) => <Svg {...p}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></Svg>;
export const IconTrash = (p: P) => <Svg {...p}><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></Svg>;
export const IconRestore = (p: P) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconX = (p: P) => <Svg {...p}><path d="M18 6L6 18M6 6l12 12" /></Svg>;
export const IconExternal = (p: P) => <Svg {...p}><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></Svg>;
export const IconWarn = (p: P) => <Svg {...p}><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></Svg>;
export const IconSave = (p: P) => <Svg {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></Svg>;

export function FileIcon({ kind, open, size = 16 }: { kind: FileKind; open?: boolean; size?: number }) {
  const cls = `hq-fx-icon hq-fx-icon--${kind}`;
  switch (kind) {
    case 'folder': return open ? <IconFolderOpen size={size} className={cls} /> : <IconFolder size={size} className={cls} />;
    case 'image': return <IconFileImage size={size} className={cls} />;
    case 'code': return <IconFileCode size={size} className={cls} />;
    case 'markdown': case 'text': return <IconFileText size={size} className={cls} />;
    case 'data': return <IconFileData size={size} className={cls} />;
    case 'archive': return <IconArchive size={size} className={cls} />;
    case 'media': return <IconMedia size={size} className={cls} />;
    case 'symlink': return <IconLink size={size} className={cls} />;
    default: return <IconBinary size={size} className={cls} />;
  }
}
