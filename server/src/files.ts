// Acesso aos arquivos reais do projeto (somente leitura) e ao git. Nada sai da pasta do projeto.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { FileNode, GitStatusEntry } from '@milweb-hq/protocol';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage', '.pnpm', '.turbo', '.cache', '__pycache__', '.venv', 'venv']);
const MAX_ENTRIES = 400;
const MAX_FILE_BYTES = 256 * 1024;

export function resolveInside(projectPath: string, rel?: string): string {
  const base = path.resolve(projectPath);
  const target = path.resolve(base, rel ?? '.');
  const relCheck = path.relative(base, target);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new Error('caminho fora da pasta do projeto');
  return target;
}

export function fileTree(projectPath: string, rel?: string, depth = 1): FileNode {
  const abs = resolveInside(projectPath, rel);
  const stat = fs.statSync(abs);
  const node: FileNode = { name: path.basename(abs) || abs, path: abs, type: stat.isDirectory() ? 'dir' : 'file', size: stat.isFile() ? stat.size : undefined, mtime: stat.mtimeMs };
  if (stat.isDirectory() && depth > 0) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => !IGNORED.has(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .slice(0, MAX_ENTRIES);
    node.children = entries.map(e => {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) return depth > 1 ? fileTree(projectPath, child, depth - 1) : { name: e.name, path: child, type: 'dir' as const };
      let size: number | undefined; let mtime: number | undefined;
      try { const s = fs.statSync(child); size = s.size; mtime = s.mtimeMs; } catch { /* ignorar */ }
      return { name: e.name, path: child, type: 'file' as const, size, mtime };
    });
  }
  return node;
}

export function readProjectFile(projectPath: string, rel: string): { content: string; truncated: boolean; binary: boolean; size: number } {
  const abs = resolveInside(projectPath, rel);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('não é um arquivo');
  const fd = fs.openSync(abs, 'r');
  try {
    const len = Math.min(stat.size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const probe = buf.subarray(0, Math.min(len, 8192));
    const binary = probe.includes(0);
    return { content: binary ? '' : buf.toString('utf8'), truncated: stat.size > MAX_FILE_BYTES, binary, size: stat.size };
  } finally { fs.closeSync(fd); }
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '') });
    });
  });
}

export async function gitStatus(projectPath: string): Promise<GitStatusEntry[] | null> {
  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || !/true/.test(inside.out)) return null;
  const r = await git(projectPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!r.ok) return null;
  return r.out.split(/\r?\n/).filter(Boolean).map(line => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3).trim().replace(/^"|"$/g, '') }));
}

export async function gitDiff(projectPath: string, rel?: string): Promise<string> {
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (rel) { resolveInside(projectPath, rel); args.push('--', rel); }
  const r = await git(projectPath, args);
  if (!r.ok) return '';
  if (r.out.trim()) return r.out;
  // Arquivo novo (não rastreado): mostra o conteúdo como adição para o usuário ver o que foi criado.
  if (rel) {
    const st = await gitStatus(projectPath);
    if (st?.some(e => e.status === '??' && samePath(e.path, rel))) {
      const f = readProjectFile(projectPath, rel);
      if (!f.binary) return `--- /dev/null\n+++ b/${rel.replace(/\\/g, '/')}\n` + f.content.split('\n').map(l => '+' + l).join('\n');
    }
  }
  return '';
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
