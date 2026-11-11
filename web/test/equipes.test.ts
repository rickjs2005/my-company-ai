// Duas equipes, duas mesas redondas (08/11): assentos alcançáveis sem atravessar mesa ou cadeira, painéis sem mistura entre
// equipes e resumo só com dados reais.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentItem, Employee, RadarItem, Task } from '@milweb-hq/protocol';
import { teamChannelLabel, teamOfEmployee, teamOfWork } from '@milweb-hq/protocol';
import { ENTRANCE, TEAM_TABLES, buildGrid, cellOf, centerOf, findPath, lineFree, teamSeat, teamTableRadius, walkable, BOSS, STUDIO_SET, MEETING } from '../src/studio/layout';
import { suggestTeams, summaryText, teamItems, teamMembers, teamRefs, teamSummary, teamTasks } from '../src/shell/social/teamBoard';

test('as duas mesas ficam lado a lado no centro, com corredor entre elas, para equipes de 2 a 6 pessoas', () => {
  const [m, g] = TEAM_TABLES;
  assert.ok(m.x < g.x, 'Aurora à esquerda, Tuco Dev à direita');
  assert.equal(m.z, g.z, 'mesma importância e altura na sala');
  for (const n of [2, 4, 6]) {
    const reach = teamTableRadius(n) + 0.5 + 0.3; // cadeira + corpo
    assert.ok(g.x - m.x - 2 * reach >= 0.9, `corredor de pelo menos 0,9 m entre as mesas com ${n} pessoas`);
  }
});

test('todo assento de equipe é alcançável pela recepção, de frente para a mesa, sem atravessar móvel', () => {
  for (const n of [2, 3, 5, 6]) {
    const grid = buildGrid({ aurora: n, 'tuco-dev': n });
    for (const team of ['aurora', 'tuco-dev'] as const) {
      const t = TEAM_TABLES.find(x => x.id === team)!;
      const cells = new Set<string>();
      for (let i = 0; i < n; i++) {
        const s = teamSeat(team, i, n);
        const c = cellOf(s.seat); cells.add(`${c.cx},${c.cz}`);
        assert.ok(walkable(grid, c.cx, c.cz), `assento ${i} de ${n} bloqueado`);
        // olhando para o centro da mesa
        const want = Math.atan2(t.x - s.seat.x, t.z - s.seat.z);
        assert.ok(Math.abs(Math.atan2(Math.sin(want - s.seat.facing), Math.cos(want - s.seat.facing))) < 0.01);
        const path = findPath(grid, ENTRANCE, s.approach);
        assert.ok(path.length > 0, `sem caminho até o assento ${i} de ${n}`);
        const s0 = cellOf(ENTRANCE); let prev = centerOf(s0.cx, s0.cz);
        for (const p of path.slice(0, -1)) { assert.ok(lineFree(grid, prev, p), 'caminho atravessa móvel'); prev = p; }
      }
      assert.equal(cells.size, n, 'cada pessoa num assento próprio');
      // o tampo da mesa é bloqueado
      const mid = cellOf({ x: t.x, z: t.z }); assert.equal(walkable(grid, mid.cx, mid.cz), false);
    }
    // áreas compartilhadas continuam alcançáveis pelas duas equipes
    for (const team of ['aurora', 'tuco-dev'] as const) {
      const from = teamSeat(team, 0, n).approach;
      for (const to of [BOSS.attend, { x: STUDIO_SET.x + 0.7, z: STUDIO_SET.z + 2.8 }, { x: MEETING.x + 2.1, z: MEETING.z + 2.75 }]) assert.ok(findPath(grid, from, to).length > 0, `${team} não chega a uma área compartilhada`);
    }
  }
});

const emp = (p: Partial<Employee>): Employee => ({ id: p.name!, name: p.name!, role: '', roomId: 'social', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, instructions: '', profileId: null, model: null, effort: null, permissionMode: 'default', activeSessionId: null, archivedAt: null, createdAt: 1, updatedAt: 1, provider: 'claude', skills: [], agent: null, template: null, access: { mcp: 'none', browser: true }, ...p } as Employee);
const task = (p: Partial<Task>): Task => ({ id: p.id!, sessionId: 's', status: 'running', prompt: 'x', createdAt: 1, profileId: null, destinationId: null, employeeId: null, errors: [], ...p } as Task);
const item = (p: Partial<ContentItem>): ContentItem => ({ id: p.id!, title: p.id!, status: 'revisar', slot: null, profileId: null, deletedAt: null, archivedAt: null, updatedAt: 1, date: '2026-11-09', ...p } as ContentItem);

test('equipe de cada pessoa: perfil gravado; sem perfil, apoio pelo papel; senão, sem equipe (atribuir)', () => {
  assert.equal(teamOfEmployee({ profileId: 'aurora' }), 'aurora');
  assert.equal(teamOfEmployee({ profileId: null, template: 'conteudo-revisor' }), 'apoio');
  assert.equal(teamOfEmployee({ profileId: null, template: null }), null);
  const { members, support, unassigned } = teamMembers([emp({ name: 'Bia', profileId: 'aurora', deskIndex: 1 }), emp({ name: 'Clara', profileId: 'aurora', deskIndex: 0 }), emp({ name: 'Nina', profileId: 'tuco-dev' }), emp({ name: 'Otto', template: 'conteudo-revisor' }), emp({ name: 'Zé' })], 'aurora', 'social');
  assert.deepEqual(members.map(e => e.name), ['Clara', 'Bia'], 'ordem do assento gravado');
  assert.deepEqual(support.map(e => e.name), ['Otto']);
  assert.deepEqual(unassigned.map(e => e.name), ['Zé']);
});

test('painel de uma equipe nunca mostra tarefa, peça ou referência da outra; filtro por canal', () => {
  const tasks = [task({ id: 't1', destinationId: 'threads' }), task({ id: 't2', destinationId: 'instagram-tuco' }), task({ id: 't3', profileId: 'aurora', destinationId: 'instagram-aurora' }), task({ id: 't4', profileId: 'tuco-dev' })];
  assert.deepEqual(teamTasks(tasks, 'aurora').map(t => t.id).sort(), ['t1', 't3']);
  assert.deepEqual(teamTasks(tasks, 'tuco-dev').map(t => t.id).sort(), ['t2', 't4']);
  assert.deepEqual(teamTasks(tasks, 'aurora', 'threads').map(t => t.id), ['t1']);
  const items = [item({ id: 'a', slot: 'threads' }), item({ id: 'b', slot: 'instagram-tuco' }), item({ id: 'c', slot: 'instagram-aurora', deletedAt: 5 })];
  assert.deepEqual(teamItems(items, 'aurora').map(i => i.id), ['a'], 'lixeira fica de fora');
  assert.deepEqual(teamItems(items, 'tuco-dev').map(i => i.id), ['b']);
  const radar = [{ id: 'r1', slot: null, subject: 's', video: { slot: 'instagram-tuco', stage: 'producao' } }, { id: 'r2', slot: 'threads', subject: 's', video: { slot: null, stage: 'recebida' } }, { id: 'r3', slot: null, subject: 's', video: null }] as unknown as RadarItem[];
  assert.deepEqual(teamRefs(radar, 'tuco-dev').map(r => r.id), ['r1']);
  assert.deepEqual(teamRefs(radar, 'aurora').map(r => r.id), ['r2']);
});

test('resumo por equipe só com dados reais; rótulo de equipe e canal na Mesa do Chefe', () => {
  const s = teamSummary('aurora', {
    tasks: [task({ id: 'x', status: 'running', destinationId: 'threads' }), task({ id: 'y', status: 'queued', destinationId: 'instagram-aurora' }), task({ id: 'z', status: 'running', destinationId: 'instagram-tuco' })],
    items: [item({ id: 'i1', slot: 'threads', status: 'revisar' }), item({ id: 'i2', slot: 'instagram-aurora', status: 'parcial' })],
    pending: [{ taskId: 'x' } as never],
  });
  assert.deepEqual(s, { running: 1, queued: 1, review: 1, blocked: 2 });
  assert.equal(summaryText(s), '1 em execução · 1 na fila · 1 em revisão · 2 bloqueios');
  assert.equal(teamChannelLabel({ destinationId: 'threads' }), 'Aurora · Threads Aurora');
  assert.equal(teamChannelLabel({ profileId: 'tuco-dev', slot: 'instagram-tuco' }), 'Tuco Dev · Instagram Tuco Dev');
  assert.equal(teamOfWork({ slot: 'tiktok' }), null, 'canal fora das duas equipes não vira equipe');
});

test('pedido geral: a sugestão de equipe vem do texto e o Chefe confirma', () => {
  assert.deepEqual(suggestTeams('Reel do Tuco sobre API'), ['tuco-dev']);
  assert.deepEqual(suggestTeams('post no Threads da Aurora'), ['aurora']);
  assert.deepEqual(suggestTeams('Preparem os conteúdos de amanhã'), ['aurora', 'tuco-dev']);
});
