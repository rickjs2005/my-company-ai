// Dados de exemplo SÓ para playgrounds de desenvolvimento (marcados como demonstração). Nunca usados no app real.
import type { ChatItem, Employee, PendingPermission, Project, Room, Session, Task, Worker } from '@milweb-hq/protocol';
import { initialActivity } from '@milweb-hq/claude-bridge/activity';

export const MOCK_BANNER = 'MODO DEMONSTRAÇÃO — dados simulados';

export const sampleRooms: Room[] = [
  { id: 'r-dev', slug: 'desenvolvimento', name: 'Desenvolvimento', kind: 'dev', instructions: 'Sites, landing pages, sistemas, correções e testes.', profiles: [], color: '#f0a830', order: 0 },
  { id: 'r-social', slug: 'social-media', name: 'Social Media', kind: 'social', instructions: 'Pautas, roteiros, legendas, carrosséis e calendários.', profiles: [{ id: 'p-aurora', name: 'Aurora', instructions: 'Trabalho, projetos, bastidores e serviços da Aurora.' }, { id: 'p-tuco', name: 'Tuco Dev', instructions: 'Conteúdo educativo sobre programação, IA, automação e tecnologia.' }], color: '#e36a5a', order: 1 },
  { id: 'r-design', slug: 'design-video', name: 'Design e Vídeo', kind: 'design', instructions: 'Briefings, interfaces, materiais visuais e projetos de vídeo (Remotion quando disponível).', profiles: [], color: '#b07ae0', order: 2 },
  { id: 'r-research', slug: 'pesquisa-prospeccao', name: 'Pesquisa e Prospecção', kind: 'research', instructions: 'Pesquisas, análise de empresas, oportunidades e preparação de abordagens.', profiles: [], color: '#6fb3e0', order: 3 },
  { id: 'r-mgmt', slug: 'gestao-revisao', name: 'Gestão e Revisão', kind: 'management', instructions: 'Visão das tarefas, entregas, pendências e verificações.', profiles: [], color: '#7cc47f', order: 4 },
];

export const sampleProjects: Project[] = [
  { id: 'p-1', name: 'Agência de turismo (demo)', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo', roomId: 'r-dev', previewUrl: 'http://127.0.0.1:3000', createdAt: 1, lastUsedAt: 2 },
  { id: 'p-2', name: 'Conteúdo Aurora (demo)', path: 'C:\\Users\\usuario\\projetos\\hq-content', roomId: 'r-social', createdAt: 1, lastUsedAt: 2 },
];

const act = initialActivity();

// Funcionários persistentes (v2): a identidade é deles, a conversa é só a sessão ativa.
export const sampleEmployees: Employee[] = [
  { id: 'e-1', name: 'Léo', role: 'Desenvolvimento', roomId: 'r-dev', appearance: { skin: 1, hair: 2, shirt: 0 }, deskIndex: 0, instructions: '', profileId: null, model: null, effort: null, permissionMode: 'default', activeSessionId: 's-1', archivedAt: null, createdAt: 1, updatedAt: 2, provider: 'claude', skills: [], agent: null, template: null, access: { mcp: 'none' } },
  { id: 'e-2', name: 'Bia', role: 'Social Media', roomId: 'r-social', appearance: { skin: 2, hair: 0, shirt: 3 }, deskIndex: 0, instructions: '', profileId: 'p-aurora', model: null, effort: null, permissionMode: 'default', activeSessionId: 's-2', archivedAt: null, createdAt: 1, updatedAt: 1, provider: 'claude', skills: [], agent: null, template: null, access: { mcp: 'none' } },
];

export const sampleSessions: Session[] = [
  { id: 's-1', claudeSessionId: '559b166a-b9c1-47a8-ab09-cba2a392b1ea', employeeId: 'e-1', roomId: 'r-dev', projectId: 'p-1', name: 'Landing turismo', model: null, permissionMode: 'default', status: 'active', controllable: true, processState: 'running', activity: { ...act, phase: 'writing', detail: 'Editando index.html', turnActive: true }, createdAt: 1, lastActiveAt: 2 },
  { id: 's-2', claudeSessionId: null, employeeId: 'e-2', roomId: 'r-social', projectId: 'p-2', name: 'Pautas da semana', model: null, permissionMode: 'default', status: 'new', controllable: true, processState: null, activity: act, createdAt: 1, lastActiveAt: 1 },
  { id: 's-3', claudeSessionId: 'a0c129dc-53a8-430e-9c37-1f2fce4682ad', employeeId: null, roomId: 'r-dev', projectId: 'p-1', name: 'Terminal do Chefe', model: null, permissionMode: 'default', status: 'observed', controllable: false, processState: null, activity: { ...act, phase: 'executing', detail: 'Executando: npm test', turnActive: true }, createdAt: 1, lastActiveAt: 2 },
];

export const sampleWorkers: Worker[] = [
  { id: 'e-1', kind: 'employee', employeeId: 'e-1', sessionId: 's-1', roomId: 'r-dev', projectId: 'p-1', name: 'Léo', role: 'Desenvolvimento', appearance: { skin: 1, hair: 2, shirt: 0 }, deskIndex: 0, phase: 'writing', detail: 'Editando index.html', status: 'running', controllable: true, busy: true },
  { id: 'e-2', kind: 'employee', employeeId: 'e-2', sessionId: 's-2', roomId: 'r-social', projectId: 'p-2', name: 'Bia', role: 'Social Media', appearance: { skin: 2, hair: 0, shirt: 3 }, deskIndex: 0, phase: 'idle', detail: 'Disponível', status: 'idle', controllable: true, busy: false },
  { id: 's-3', kind: 'observed', employeeId: null, sessionId: 's-3', roomId: 'r-dev', projectId: 'p-1', name: 'Chefe (terminal)', role: 'Desenvolvimento', appearance: { skin: 0, hair: 1, shirt: 2 }, deskIndex: 1, phase: 'executing', detail: 'Executando: npm test', status: 'observed', controllable: false, busy: true },
];

export const sampleTasks: Task[] = [
  { id: 't-1', sessionId: 's-1', projectId: 'p-1', roomId: 'r-dev', prompt: 'Crie uma landing page para uma agência de turismo', attachments: [], status: 'running', createdAt: 1, startedAt: 2, errors: [], deliverables: [], touchedFiles: ['C:\\Users\\usuario\\projetos\\exemplo-turismo\\index.html'] },
  { id: 't-0', sessionId: 's-1', projectId: 'p-1', roomId: 'r-dev', prompt: 'Inicie o projeto com Vite', attachments: [], status: 'done', createdAt: 0, startedAt: 0, finishedAt: 1, resultText: 'Projeto criado com Vite + React. Rode `pnpm dev` para abrir.', resultSubtype: 'success', errors: [], durationMs: 48000, numTurns: 9, costUsd: 0.12, deliverables: [{ id: 'd-1', taskId: 't-0', kind: 'file', title: 'package.json', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo\\package.json', changeType: 'created', createdAt: 1 }, { id: 'd-2', taskId: 't-0', kind: 'url', title: 'Preview local', url: 'http://127.0.0.1:3000', createdAt: 1 }], touchedFiles: ['C:\\Users\\usuario\\projetos\\exemplo-turismo\\package.json'] },
];

export const sampleChat: ChatItem[] = [
  { id: 'c-1', ts: 1, taskId: 't-0', kind: 'user', text: 'Inicie o projeto com Vite', attachments: [] },
  { id: 'c-2', ts: 2, taskId: 't-0', kind: 'tool', toolUseId: 'tu-1', name: 'Bash', summary: 'Executando: Create Vite project', input: { command: 'pnpm create vite . --template react-ts' }, output: 'Done. Now run: pnpm install', isError: false, done: true },
  { id: 'c-3', ts: 3, taskId: 't-0', kind: 'assistant', text: 'Projeto criado com **Vite + React**. Rode `pnpm dev` para abrir.' },
  { id: 'c-4', ts: 4, taskId: 't-0', kind: 'result', status: 'done', summary: 'Resposta pronta em 48 s (9 passos)', durationMs: 48000, numTurns: 9, costUsd: 0.12 },
  { id: 'c-5', ts: 5, taskId: 't-1', kind: 'user', text: 'Crie uma landing page para uma agência de turismo', attachments: [] },
  { id: 'c-6', ts: 6, taskId: 't-1', kind: 'tool', toolUseId: 'tu-2', name: 'Write', summary: 'Escrevendo index.html', input: { file_path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo\\index.html' }, done: false },
];

export const samplePending: PendingPermission[] = [
  { sessionId: 's-1', taskId: 't-1', isQuestion: false, request: { requestId: 'req-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'pnpm install', description: 'Install dependencies' }, description: 'Install dependencies', decisionReason: 'This command requires approval', permissionSuggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm install' }], behavior: 'allow', destination: 'localSettings' }], receivedAt: 7, toolUseId: 'tu-3' } },
  { sessionId: 's-1', taskId: 't-1', isQuestion: true, questions: [{ question: 'Qual paleta você prefere?', header: 'Paleta', options: [{ label: 'Azul oceano', description: 'Tons frios' }, { label: 'Pôr do sol', description: 'Tons quentes' }] }], request: { requestId: 'req-2', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Qual paleta você prefere?', header: 'Paleta', options: [{ label: 'Azul oceano', description: 'Tons frios' }, { label: 'Pôr do sol', description: 'Tons quentes' }] }] }, requiresUserInteraction: true, receivedAt: 8, toolUseId: 'tu-4' } },
];
