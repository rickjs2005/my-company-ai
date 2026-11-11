// Sala Social Media (piloto isométrico): geometria da sala e regras do mural, da mesa do Chefe e da mesa de reunião.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiProviderStatus, ContentItem, Session, SocialAccount, SocialState, Task } from '@milweb-hq/protocol';
import { CONTENT_H, CONTENT_W, DESKS, LOW_H, LOW_W, ROOM_H, ROOM_W, WALL_H, ZOOM_MAX, ZOOM_MIN, approachFor, blockedTiles, bubbleFor, fitZoom, fromLow, pointInPoly, toLow, type IsoTarget } from '../src/scene/iso/socialRoom';
import { boardCounts, captionOf, columnOf, destinationLabel, destinationOf, destinationState, destinationsFor, displayPrompt, isVideoTask, meetingAvailability, pieceFiles, pieceKind, pieceOfTask, roomTasks, waitingForChefe, withDestination } from '../src/shell/social/socialHelpers';
import { connectedCount, nextHubStep, testPostText } from '../src/shell/social/SocialHub';

const task = (t: Partial<Task> & Pick<Task, 'id'>): Task => ({
  sessionId: 's1', projectId: 'p1', roomId: 'r-social', prompt: 'x', attachments: [], status: 'done', createdAt: 1, errors: [], deliverables: [], touchedFiles: [], ...t,
} as Task);

test('geometria: fromLow desfaz toLow no piso e os quatro cantos da sala cabem na imagem base', () => {
  for (const [x, y] of [[0, 0], [3.5, 8.9], [ROOM_W, ROOM_H], [11.2, 0.4]]) {
    const p = toLow(x, y); const w = fromLow(p.x, p.y);
    assert.ok(Math.abs(w.x - x) < 1e-9 && Math.abs(w.y - y) < 1e-9, `(${x}, ${y})`);
  }
  for (const [x, y] of [[0, 0], [ROOM_W, 0], [0, ROOM_H], [ROOM_W, ROOM_H]]) {
    const p = toLow(x, y);
    assert.ok(p.x >= 0 && p.x <= LOW_W && p.y >= 0 && p.y <= LOW_H, `canto (${x}, ${y}) fora da imagem`);
  }
});

test('fitZoom: o que é desenhado cabe no palco, em passos de 0,25 e dentro dos limites', () => {
  // o desenho (topo das paredes até a quina da frente do piso) fica dentro da área de conteúdo
  const extremes = [toLow(0, 0, WALL_H + 5), toLow(0, ROOM_H, WALL_H + 5), toLow(ROOM_W, 0, WALL_H + 5), toLow(ROOM_W, ROOM_H)];
  const mx = (LOW_W - CONTENT_W) / 2, my = (LOW_H - CONTENT_H) / 2;
  for (const p of extremes) assert.ok(p.x >= mx - 1 && p.x <= LOW_W - mx + 1 && p.y >= my - 6 && p.y <= LOW_H - my + 1, `(${p.x}, ${p.y}) fora do conteúdo`);
  for (const [w, h] of [[1366 - 70, 768 - 150], [1920 - 70, 1080 - 130], [880, 615], [800, 500], [4000, 3000], [200, 150]]) {
    const z = fitZoom(w, h);
    assert.ok(z >= ZOOM_MIN && z <= ZOOM_MAX, `zoom ${z}`);
    assert.equal(Math.round(z * 4), z * 4);
    if (z > ZOOM_MIN) assert.ok(CONTENT_W * z <= w && CONTENT_H * z <= h, `${w}x${h}: a sala não cabe com zoom ${z}`);
  }
  // Sala de 16x12 (06/11, duas equipes): 1366×768 (palco real ~1296×615) mostra a sala inteira em tamanho real; 1920×1080 maior
  assert.ok(fitZoom(1296, 615) >= 1);
  assert.ok(fitZoom(1850, 950) >= 1.5);
});

test('pointInPoly: losango do piso', () => {
  const tile = [toLow(0, 0), toLow(1, 0), toLow(1, 1), toLow(0, 1)];
  const c = toLow(0.5, 0.5);
  assert.equal(pointInPoly(c.x, c.y, tile), true);
  const out = toLow(1.5, 0.5);
  assert.equal(pointInPoly(out.x, out.y, tile), false);
});

test('caminhos: o avatar alcança a frente de cada mesa, da mesa do Chefe, do mural, do armário e da porta', () => {
  const free = blockedTiles();
  // as mesas e cadeiras são obstáculos
  for (const d of DESKS) assert.equal(free[d.y0][d.x0], false);
  const seen = new Set<string>(); const queue = [[11, 10]];
  assert.equal(free[10][11], true, 'o avatar nasce num tile livre');
  while (queue.length) {
    const [x, y] = queue.shift()!; const k = `${x},${y}`;
    if (seen.has(k) || !free[y]?.[x]) continue; seen.add(k);
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const reach = (x: number, y: number, what: string) => assert.ok(seen.has(`${x},${y}`), `não alcança ${what} (${x}, ${y})`);
  for (const d of DESKS) reach(d.x0, d.y0 + 1, `a frente da mesa em (${d.x0}, ${d.y0})`);
  reach(13, 9, 'a mesa do Chefe');
  reach(4, 0, 'o mural');
  reach(1, 3, 'o armário de mídia');
  reach(0, 10, 'a porta');
  reach(11, 3, 'o estúdio');
  // o avatar para num tile livre e alcançável diante de cada objeto (e de cada mesa)
  const targets: IsoTarget[] = [{ kind: 'chefe-desk' }, { kind: 'board' }, { kind: 'socials' }, { kind: 'media-cabinet' }, { kind: 'meeting-table' }, { kind: 'door' }, { kind: 'studio' },
    ...DESKS.map((_, i) => ({ kind: 'desk' as const, deskIndex: i, workerId: null }))];
  for (const t of targets) {
    const a = approachFor(t); assert.ok(a, t.kind);
    reach(Math.floor(a!.x), Math.floor(a!.y), `o ponto de parada de ${t.kind}`);
  }
  assert.deepEqual(approachFor({ kind: 'worker', id: 'bia' }, id => (id === 'bia' ? 2 : null)), approachFor({ kind: 'desk', deskIndex: 2, workerId: 'bia' }));
  assert.equal(approachFor({ kind: 'worker', id: 'ninguem' }, () => null), null);
  // nenhum tile livre fica isolado (dá para andar até qualquer lugar livre)
  let freeCount = 0; for (const row of free) for (const c of row) if (c) freeCount++;
  assert.equal(seen.size, freeCount);
});

test('destino: a conta vai no começo do pedido, é lida de volta (rede) e some do texto mostrado', () => {
  const ig = destinationLabel({ label: 'Instagram · Aurora', username: 'aurora' });
  assert.equal(ig, 'Instagram · Aurora (@aurora)');
  const p = withDestination('Roteiro de reels sobre landing pages', ig);
  assert.equal(p, '[Destino: Instagram · Aurora (@aurora)] Roteiro de reels sobre landing pages');
  assert.equal(destinationOf(p), 'instagram');
  assert.equal(withDestination(p, 'Threads'), '[Destino: Threads] Roteiro de reels sobre landing pages', 'trocar o destino não acumula marcadores');
  assert.equal(destinationOf('[Destino: Threads] oi'), 'threads');
  assert.equal(destinationOf('[Destino: Instagram] pedido antigo'), 'instagram', 'pedidos antigos (só a rede) continuam reconhecidos');
  assert.equal(withDestination(p, null), 'Roteiro de reels sobre landing pages');
  assert.equal(destinationOf('sem destino'), null);
  const full = `/social ${p}\n\nArquivos de contexto escolhidos pelo Chefe (leia antes):\n- briefing.md`;
  assert.equal(displayPrompt(full), 'Roteiro de reels sobre landing pages');
});

const acc = (o: Partial<SocialAccount> & Pick<SocialAccount, 'slot' | 'network' | 'label'>): SocialAccount => ({
  mode: 'api', siteUrl: 'https://example.com/', declared: null,
  remoteId: null, username: null, displayName: null, avatar: null, accountKind: null, profileIds: [], status: 'not_connected', statusDetail: '', scopes: [],
  capabilities: { authenticated: { state: 'unknown', detail: '' }, read: { state: 'unknown', detail: '' }, publish: { state: 'unknown', detail: '' }, schedule: { state: 'unknown', detail: '' } },
  connectedAt: null, lastCheckAt: null, lastCheckOk: null, lastError: null, tokenExpiresAt: null, nextStep: null, lastPublish: null, ...o,
});

test('destinos por perfil: o perfil filtra as contas; estado curto diz o que a conexão permite', () => {
  const igM = acc({ slot: 'instagram-aurora', network: 'instagram', label: 'Instagram · Aurora', profileIds: ['aurora'], status: 'connected', remoteId: '1', username: 'aurora',
    capabilities: { authenticated: { state: 'tested', detail: '' }, read: { state: 'tested', detail: '' }, publish: { state: 'reported', detail: 'x', hqReady: false }, schedule: { state: 'unavailable', detail: '' } } });
  const igG = acc({ slot: 'instagram-tuco', network: 'instagram', label: 'Instagram · Tuco Dev', profileIds: ['tuco-dev'] });
  const th = acc({ slot: 'threads', network: 'threads', label: 'Threads', profileIds: ['aurora', 'tuco-dev'], status: 'connected', remoteId: '2',
    capabilities: { authenticated: { state: 'tested', detail: '' }, read: { state: 'tested', detail: '' }, publish: { state: 'reported', detail: 'x', hqReady: true }, schedule: { state: 'unavailable', detail: '' } } });
  const tt = acc({ slot: 'tiktok', network: 'tiktok', label: 'TikTok' });
  const all = [igM, igG, th, tt];
  assert.deepEqual(destinationsFor(all, 'aurora').map(a => a.slot), ['instagram-aurora', 'threads']);
  assert.deepEqual(destinationsFor(all, 'tuco-dev').map(a => a.slot), ['instagram-tuco', 'threads']);
  assert.equal(destinationState(igM), 'conectada · a HQ prepara, você posta');
  assert.equal(destinationState(th), 'conectada · a HQ publica texto');
  assert.equal(destinationState(igG), 'não conectada');
  assert.equal(destinationState({ ...th, status: 'expired' }), 'reconectar');
  assert.equal(connectedCount({ accounts: all } as SocialState), 2);
});

test('central: a ordem do que depende do Chefe (página de retorno → app → contas → perfil)', () => {
  const base = (o: Partial<SocialState>): SocialState => ({
    accounts: [acc({ slot: 'instagram-aurora', network: 'instagram', label: 'Instagram · Aurora', profileIds: ['aurora'] }), acc({ slot: 'instagram-tuco', network: 'instagram', label: 'Instagram · Tuco Dev', profileIds: ['tuco-dev'] }),
      acc({ slot: 'threads', network: 'threads', label: 'Threads' }), acc({ slot: 'tiktok', network: 'tiktok', label: 'TikTok' }), acc({ slot: 'linkedin', network: 'linkedin', label: 'LinkedIn' })],
    apps: (['instagram', 'threads', 'tiktok', 'linkedin'] as const).map(app => ({ app, label: app, configured: false, clientIdHint: null, consoleUrl: '', steps: [] })),
    redirectUri: 'https://aurora.example/hq-retorno.html', redirectCheck: { ok: true, detail: '', at: 1 }, vault: { kind: 'dpapi', ok: true, detail: '' }, checkedAt: null, ...o,
  });
  assert.match(nextHubStep(base({ redirectCheck: { ok: false, detail: '404', at: 1 } }))!.text, /página de retorno/);
  assert.equal(nextHubStep(base({}))!.app, 'instagram');
  const withIgApp = base({}); withIgApp.apps[0].configured = true;
  assert.match(nextHubStep(withIgApp)!.text, /Conectar Instagram · Aurora/);
  withIgApp.accounts[0] = { ...withIgApp.accounts[0], remoteId: '1', status: 'connected' };
  assert.match(nextHubStep(withIgApp)!.text, /Conectar Instagram · Tuco Dev/);
  withIgApp.accounts[1] = { ...withIgApp.accounts[1], remoteId: '2', status: 'connected' };
  assert.equal(nextHubStep(withIgApp)!.app, 'threads');
  assert.match(testPostText(withIgApp.accounts[2]), /Threads\. Pode ignorar\.$/);
});

test('mural: colunas pelo estado real; nada aparece como agendado ou publicado', () => {
  assert.equal(columnOf(task({ id: 'a', status: 'queued' })), 'fila');
  assert.equal(columnOf(task({ id: 'b', status: 'running' })), 'producao');
  assert.equal(columnOf(task({ id: 'c', status: 'waiting_answer' })), 'producao');
  assert.equal(columnOf(task({ id: 'd', status: 'done' })), 'revisar');
  assert.equal(columnOf(task({ id: 'e', status: 'done', review: 'verified' } as Partial<Task> & { id: string })), 'revisado');
  assert.equal(columnOf(task({ id: 'f', status: 'error' })), 'falhou');
  assert.deepEqual(boardCounts([task({ id: 'a', status: 'queued' }), task({ id: 'b', status: 'running' }), task({ id: 'd', status: 'done' }), task({ id: 'f', status: 'interrupted' }), task({ id: 'g', status: 'done', review: 'verified' } as Partial<Task> & { id: string })]), { queued: 1, producing: 1, review: 1, ready: 1 });
});

test('roomTasks: só as conversas da sala, filtro por perfil e mais recentes primeiro', () => {
  const sessions = [{ id: 's1', roomId: 'r-social' }, { id: 's2', roomId: 'r-dev' }] as Session[];
  const tasks = [
    task({ id: 'old', sessionId: 's1', createdAt: 1, profileId: 'aurora' }),
    task({ id: 'new', sessionId: 's1', createdAt: 5, profileId: 'tuco-dev' }),
    task({ id: 'dev', sessionId: 's2', roomId: 'r-dev', createdAt: 9, profileId: 'aurora' }),
  ];
  assert.deepEqual(roomTasks(tasks, sessions, 'r-social', null).map(t => t.id), ['new', 'old']);
  assert.deepEqual(roomTasks(tasks, sessions, 'r-social', 'aurora').map(t => t.id), ['old']);
  assert.deepEqual(roomTasks(tasks, sessions, null, null), []);
});

test('mesa do Chefe: respostas pendentes e entregas sem revisão', () => {
  const r = waitingForChefe([
    task({ id: 'perm', status: 'waiting_permission' }), task({ id: 'q', status: 'waiting_answer' }),
    task({ id: 'pronta', status: 'done' }), task({ id: 'revisada', status: 'done', review: 'verified' } as Partial<Task> & { id: string }), task({ id: 'rodando', status: 'running' }),
  ]);
  assert.deepEqual(r.needsAnswer.map(t => t.id), ['perm', 'q']);
  assert.deepEqual(r.toReview.map(t => t.id), ['pronta']);
});

test('mesa de reunião: disponibilidade honesta de cada provedor', () => {
  const p = (o: Partial<AiProviderStatus>): AiProviderStatus => ({ provider: 'claude', label: 'Claude', routeLabel: 'Claude Code', installed: true, authState: 'ok', lastTest: null, ...o } as AiProviderStatus);
  const r = meetingAvailability([
    p({}),
    p({ provider: 'openai', label: 'ChatGPT', routeLabel: 'Codex', authState: 'ok' }),
  ]);
  assert.deepEqual(r[0], { name: 'Claude', ok: true, detail: 'disponível' });
  assert.equal(r[1].ok, true); assert.match(r[1].detail, /ainda não validada/);
  assert.equal(meetingAvailability([p({ provider: 'openai', installed: false, routeLabel: 'Codex' })])[0].ok, false);
  assert.equal(meetingAvailability([p({ authState: 'missing' as AiProviderStatus['authState'] })])[0].detail, 'sem login');
});

test('balões: o que cada funcionário faz de verdade; nada quando está livre ou é sessão observada', () => {
  const w = (o: Partial<Parameters<typeof bubbleFor>[0]>) => ({ phase: 'idle', detail: '', status: 'idle', observed: false, ...o }) as Parameters<typeof bubbleFor>[0];
  assert.equal(bubbleFor(w({})), null);
  assert.equal(bubbleFor(w({ phase: 'writing', observed: true, status: 'running' })), null);
  assert.deepEqual(bubbleFor(w({ phase: 'thinking', status: 'running' })), { text: 'pensando', tone: 'work' });
  assert.deepEqual(bubbleFor(w({ phase: 'writing', status: 'running', detail: 'Editando roteiro-reels.md' })), { text: 'Editando roteiro-reels.md', tone: 'work' });
  assert.equal(bubbleFor(w({ phase: 'executing', status: 'running', detail: 'x'.repeat(60) }))!.text.length, 34);
  assert.equal(bubbleFor(w({ status: 'waiting_permission', phase: 'waiting_permission' }))!.tone, 'wait');
  assert.equal(bubbleFor(w({ status: 'waiting_answer' }))!.text, 'tem uma pergunta para você');
  assert.deepEqual(bubbleFor(w({ status: 'queued' })), { text: 'na fila', tone: 'queue' });
  assert.equal(bubbleFor(w({ status: 'error' }))!.tone, 'error');
});

test('peça: arquivos entregues relativos ao projeto, texto e mídia primeiro, sem repetir nem sair do projeto', () => {
  const t = task({ id: 'p', deliverables: [
    { id: '1', taskId: 'p', kind: 'file', title: 'v', path: 'C:\\proj\\video\\corte.mp4', changeType: 'created', createdAt: 1 },
    { id: '2', taskId: 'p', kind: 'file', title: 'r', path: 'C:\\proj\\roteiro.md', changeType: 'created', createdAt: 1 },
    { id: '3', taskId: 'p', kind: 'file', title: 'r2', path: 'c:/proj/ROTEIRO.md', changeType: 'modified', createdAt: 1 },
    { id: '4', taskId: 'p', kind: 'file', title: 'x', path: 'C:\\outro\\x.md', changeType: 'created', createdAt: 1 },
    { id: '5', taskId: 'p', kind: 'file', title: 'd', path: 'C:\\proj\\velho.md', changeType: 'deleted', createdAt: 1 },
  ], touchedFiles: ['C:\\proj\\tocado.txt'] });
  assert.deepEqual(pieceFiles(t, 'C:\\proj').map(f => [f.rel, f.kind]), [['roteiro.md', 'text'], ['video/corte.mp4', 'video']]);
  // sem entregas, os arquivos tocados
  assert.deepEqual(pieceFiles(task({ id: 'q', touchedFiles: ['C:\\proj\\capa.png'] }), 'C:\\proj').map(f => f.kind), ['image']);
  assert.deepEqual(pieceFiles(t, null), []);
  assert.equal(pieceKind('a/b/Story.JPEG'), 'image');
  assert.equal(pieceKind('legenda.srt'), 'text');
  assert.equal(pieceKind('arquivo.psd'), 'other');
});

test('legenda: seção por título ou rótulo, até o próximo título; nada quando não existe', () => {
  const md = ['# Reels: 3 erros em landing pages', '', '## Roteiro', 'Cena 1: ...', '', '## Legenda', 'Sua landing page perde clientes?', 'Veja os 3 erros.', '', '## Hashtags', '#landingpage'].join('\n');
  assert.equal(captionOf(md), 'Sua landing page perde clientes?\nVeja os 3 erros.');
  assert.equal(captionOf('Roteiro...\n**Legenda:** Texto curto do post\ncontinua aqui\n\n**Hashtags:**\n#x'), 'Texto curto do post\ncontinua aqui');
  assert.equal(captionOf('### Legenda sugerida (Instagram)\r\nLinha 1\r\n---\r\nresto'), 'Linha 1');
  assert.equal(captionOf('Legendas automáticas ajudam quem assiste sem som.'), null);
  assert.equal(captionOf('Legenda do vídeo deve ser curta.'), null);
  assert.equal(captionOf('## Legenda\n\n## Outra'), null);
});

test('estúdio: peças de vídeo pela skill, por arquivo de vídeo ou pelo pedido (com acento)', () => {
  assert.equal(isVideoTask(task({ id: 'a', prompt: 'qualquer coisa', skill: { requested: 'milweb-video-studio' } as Task['skill'] })), true);
  assert.equal(isVideoTask(task({ id: 'b', prompt: 'post', deliverables: [{ id: '1', taskId: 'b', kind: 'file', title: 'v', path: 'C:\\p\\a.mov', createdAt: 1 }] })), true);
  assert.equal(isVideoTask(task({ id: 'c', prompt: '[Destino: TikTok] Roteiro de vídeo sobre IA' })), true);
  assert.equal(isVideoTask(task({ id: 'd', prompt: 'Ideias de Reels para a Aurora' })), true);
  assert.equal(isVideoTask(task({ id: 'e', prompt: 'Carrossel sobre SEO com 5 slides' })), false);
  assert.equal(isVideoTask(task({ id: 'f', prompt: 'Revisar videografia antiga' })), false);
});

test('cartão do Mural acha a peça do calendário: pela tarefa gravada ou pela pasta onde a tarefa entregou (rodadas antigas também)', () => {
  const folder = 'C:\\conteudo\\marcas\\aurora\\pecas\\2026-11-04-instagram-olaria';
  const item = { id: 'i1', taskId: 'prod-2', reviewTaskId: 'rev-1', folder, status: 'revisar' } as ContentItem;
  const other = { id: 'i2', taskId: null, reviewTaskId: null, folder: 'C:\\conteudo\\marcas\\aurora\\pecas\\2026-11-04-instagram-olaria-2', status: 'revisar' } as ContentItem;
  const items = [other, item];
  assert.equal(pieceOfTask(items, task({ id: 'prod-2' }))?.id, 'i1');
  assert.equal(pieceOfTask(items, task({ id: 'rev-1' }))?.id, 'i1');
  assert.equal(pieceOfTask(items, task({ id: 'prod-1', deliverables: [{ kind: 'file', path: 'C:/conteudo/marcas/aurora/pecas/2026-11-04-instagram-olaria/peca.md', changeType: 'created' }] as Task['deliverables'] }))?.id, 'i1', 'rodada antiga, pela pasta (barras normais)');
  assert.equal(pieceOfTask(items, task({ id: 'radar', deliverables: [{ kind: 'file', path: 'C:\\conteudo\\radar\\2026-11-03-0800\\radar.md', changeType: 'created' }] as Task['deliverables'] })), null, 'Radar não é peça');
  assert.equal(pieceOfTask([{ ...item, taskId: null, reviewTaskId: null, status: 'descartada' } as ContentItem], task({ id: 'x', touchedFiles: [folder + '\\peca.md'] })), null, 'peça descartada não volta pelo cartão');
});

test('equipes na sala (06/11): cada papel e perfil tem a sua mesa; as mesas não se repetem; quem não é da equipe fica livre', async () => {
  const { seatFor, TEAM_AREAS } = await import('../src/scene/iso/socialRoom');
  const seats = [['conteudo-criador', 'tuco-dev'], ['conteudo-video', 'tuco-dev'], ['conteudo-criador', 'aurora'], ['conteudo-video', 'aurora'], ['conteudo-pesquisador', null], ['conteudo-coordenador', null], ['conteudo-revisor', null], ['conteudo-diretor-video', null]].map(([t, p]) => seatFor(t, p));
  assert.deepEqual(seats, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(seats.length, DESKS.length, 'uma mesa para cada um dos oito (com o Diretor de Vídeo)');
  assert.equal(seatFor('conteudo-criador', null), null, 'criação sem equipe não ganha mesa de equipe');
  assert.equal(seatFor(null, null), null);
  // as duas mesas de cada equipe ficam dentro do tapete dela
  for (const [i, area] of [[0, 0], [1, 0], [2, 1], [3, 1]] as const) { const d = DESKS[i]; const a = TEAM_AREAS[area]; assert.ok(d.x0 >= a.x0 && d.x0 + 2 <= a.x1 && d.y0 >= a.y0 && d.y0 + 1 <= a.y1, `mesa ${i} na ${a.label}`); }
});
