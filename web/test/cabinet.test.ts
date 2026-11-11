// Marco 1: armário de projetos (arquivos recentes dos funcionários, caminho relativo ao projeto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project, Task } from '@milweb-hq/protocol';
import { recentProjectFiles, relativeToProject } from '../src/shell/ProjectCabinet';

const project: Project = { id: 'p1', name: 'Acme', path: 'C:\\Users\\chefe\\projetos\\acme', roomId: 'r1', createdAt: 0, lastUsedAt: 0 };
const task = (id: string, at: number, files: string[], projectId = 'p1'): Task => ({
  id, sessionId: 's', projectId, roomId: 'r1', prompt: 'x', attachments: [], status: 'done', createdAt: at, startedAt: at, finishedAt: at,
  resultText: null, resultSubtype: null, terminalReason: null, errors: [], durationMs: null, numTurns: null, costUsd: null, deliverables: [], touchedFiles: files,
} as unknown as Task);

test('caminho tocado vira relativo ao projeto; fora do projeto fica de fora', () => {
  assert.equal(relativeToProject(project.path, 'C:\\Users\\chefe\\projetos\\acme\\index.html'), 'index.html');
  assert.equal(relativeToProject(project.path, 'c:/users/chefe/projetos/acme/css/styles.css'), 'css/styles.css');
  assert.equal(relativeToProject(project.path, 'C:\\Users\\chefe\\outro\\x.txt'), null);
  assert.equal(relativeToProject(project.path, 'script.js'), 'script.js');
});

test('arquivos recentes: mais novo primeiro, sem repetir, só deste projeto', () => {
  const tasks = [
    task('a', 10, ['C:\\Users\\chefe\\projetos\\acme\\index.html']),
    task('b', 30, ['C:\\Users\\chefe\\projetos\\acme\\styles.css', 'C:\\Users\\chefe\\projetos\\acme\\index.html']),
    task('c', 20, ['C:\\Users\\chefe\\projetos\\outro\\z.txt'], 'p2'),
  ];
  assert.deepEqual(recentProjectFiles(project, tasks), ['index.html', 'styles.css']);
  assert.deepEqual(recentProjectFiles(project, tasks, 1), ['index.html']);
});
