// Navegador da HQ contra um site falso local (login, link "Perfil", editor e botão Publicar), com o Edge instalado em modo
// headless e perfis em pasta temporária: login reaproveitado depois de fechar, perfis separados por conta, identidade
// diferente do cadastro, porta de publicação (aprovação, texto no editor, intenção antes do clique, sem duplicar),
// resultado incerto e controle manual. Nenhuma rede real é tocada.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SocialAccount, SocialSlotId } from '@milweb-hq/protocol';
import { slotDef } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { BrowserBroker, type ContentGate } from '../src/browser/broker.js';
import type { NetworkDef } from '../src/browser/networks.js';
import { tempDir } from './tmp.js';

// ---------- site falso
const posts: string[] = [];
let silentPublish = false;
const server = http.createServer((req, res) => {
  const cookie = req.headers.cookie ?? '';
  const user = /sessionid=([a-z0-9.]+)/.exec(cookie)?.[1] ?? null;
  const html = (b: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><body>${b}</body></html>`); };
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/login' && req.method === 'POST') {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => { const name = new URLSearchParams(b).get('user') ?? 'x'; res.writeHead(302, { 'set-cookie': `sessionid=${name}; Path=/; Max-Age=86400`, location: '/' }); res.end(); });
    return;
  }
  if (u.pathname === '/login') return html('<form method="post" action="/login"><label>Usuário <input name="user"></label><button>Entrar</button></form>');
  if (u.pathname === '/') return html(user ? `<nav><a href="/${user}/">Perfil</a></nav><main><a href="/compose">Criar</a></main>` : '<button>Entrar</button>');
  if (u.pathname === '/compose') return html(`<main><label>Texto <textarea id="t"></textarea></label><input type="file" id="f"><button id="p" aria-label="Publicar">Publicar</button>
    <script>document.getElementById('p').onclick=async()=>{ if(${silentPublish ? 'true' : 'false'}) return; const r=await fetch('/api-post',{method:'POST',body:document.getElementById('t').value}); location.href='/p/'+(await r.text()); };</script></main>`);
  if (u.pathname === '/api-post' && req.method === 'POST') { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { posts.push(b); res.end(String(posts.length)); }); return; }
  if (u.pathname === '/feed') return html(`<main><h1>Feed de teste</h1><article><p>Post sobre centralizar uma div</p><a href="/post/7">abrir post</a>
    <button aria-label="Curtir">♥</button><button data-testid="retweet">↻</button><a href="http://localhost:${(server.address() as AddressInfo).port}/feed">site externo</a></article></main>`);
  if (u.pathname === '/post/7') return html('<article><p>Post completo: centralizar div continua difícil em 2026</p></article>');
  const m = /^\/p\/(\d+)$/.exec(u.pathname);
  if (m) return html(`<article><p>${posts[Number(m[1]) - 1] ?? 'não existe'}</p></article>`);
  res.writeHead(404); res.end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const fakeNet = (): NetworkDef => ({
  network: 'instagram', loginUrl: `${base}/login`, homeUrl: `${base}/`, cookieUrls: [base], authCookies: ['sessionid'], scheduleNative: 'nao',
  async identity(page) {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const href = await page.getByRole('link', { name: 'Perfil' }).getAttribute('href', { timeout: 2000 }).catch(() => null);
    const h = href ? /^\/([a-z0-9.]+)\/$/.exec(href)?.[1] ?? null : null;
    return { loggedIn: Boolean(h), handle: h, name: null, evidence: href ? `link Perfil ${href}` : 'sem link Perfil' };
  },
});

function setup(declared: Partial<Record<SocialSlotId, string>>, gateOk = true) {
  const dir = tempDir('hq-nav-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'b') });
  const calls: string[] = [];
  const attempts = new Map<string, string>();
  const account = (slot: SocialSlotId): SocialAccount => ({
    slot, network: slotDef(slot).network, mode: 'api', label: slotDef(slot).label, siteUrl: '', remoteId: null, username: null, displayName: null, avatar: null, accountKind: null,
    declared: declared[slot] ? { handle: declared[slot]!, profileUrl: null, source: 'chefe', confirmed: true, toCreate: false, at: 1 } : null,
    profileIds: [], status: 'manual', statusDetail: '', scopes: [], connectedAt: null, lastCheckAt: null, lastCheckOk: null, lastError: null, tokenExpiresAt: null, nextStep: null, lastPublish: null,
    capabilities: { authenticated: { state: 'unknown', detail: '' }, read: { state: 'unknown', detail: '' }, publish: { state: 'unknown', detail: '' }, schedule: { state: 'unknown', detail: '' } },
  });
  const content: ContentGate = {
    folder: () => dir,
    publishGate: (itemId, slot) => gateOk ? { ok: true, text: 'Teste de peça aprovada para o site falso', title: null, files: [], destinationUrl: null } : { ok: false, reason: 'a peça não está aprovada' },
    openAttempt: itemId => { const s = attempts.get(itemId); return s && ['intencao', 'clicado', 'a_verificar'].includes(s) ? { clientId: `nav:${itemId}:1`, status: s } : null; },
    browserIntent: (itemId) => { calls.push('intencao'); attempts.set(itemId, 'intencao'); return `nav:${itemId}:1`; },
    browserClicked: (itemId) => { calls.push('clicado'); attempts.set(itemId, 'clicado'); },
    browserUncertain: (itemId) => { calls.push('a_verificar'); attempts.set(itemId, 'a_verificar'); },
    browserNotFound: (itemId) => { calls.push('nao_encontrado'); attempts.set(itemId, 'falhou'); },
    browserPublished: (itemId, url) => { calls.push(`publicado ${url}`); attempts.set(itemId, 'published'); },
    browserResult: () => { calls.push('resultado'); },
  };
  const notes: string[] = [];
  const broker = new BrowserBroker({
    db, profilesRoot: path.join(dir, 'perfis'), account, content, notify: (_s, _l, t) => notes.push(t), sessionLabel: () => 'Bia', onChange: () => {},
    log: { info: () => {}, warn: () => {} }, networks: { instagram: fakeNet() }, headless: true, idleMs: 60_000, loginWatchMs: 60_000,
  });
  return { broker, db, calls, notes, dir };
}

/** O "Chefe" entra no site falso pela janela aberta pela HQ (o teste preenche o formulário que ele preencheria). */
async function chefeLogs(broker: BrowserBroker, user: string) {
  const page = (broker as unknown as { cur: { page: import('playwright-core').Page } }).cur.page;
  await page.getByLabel('Usuário').fill(user);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(`${base}/`);
}
const until = async (fn: () => boolean, ms = 15_000) => { const t = Date.now() + ms; while (!fn()) { if (Date.now() > t) throw new Error('tempo esgotado'); await new Promise(r => setTimeout(r, 200)); } };

test('login na janela da HQ é detectado, conferido com o cadastro e reaproveitado depois de fechar e reabrir; o outro Instagram continua separado', async () => {
  const { broker } = setup({ 'instagram-aurora': 'auroraexemplo', 'instagram-tuco': 'tucoexemplo' });
  try {
    assert.equal(broker.view('instagram-aurora').state, 'cadastrada');
    await broker.connect('instagram-aurora');
    assert.equal(broker.view('instagram-aurora').state, 'aguardando_login');
    await chefeLogs(broker, 'auroraexemplo');
    await until(() => broker.view('instagram-aurora').state === 'verificada');
    assert.equal(broker.view('instagram-aurora').detectedHandle, 'auroraexemplo');
    await broker.shutdown();
    assert.equal(broker.view('instagram-aurora').open, false);
    // reabre: a sessão continua no perfil da conta
    const v = await broker.verify('instagram-aurora') as { state: string };
    assert.equal(v.state, 'verificada');
    // o outro Instagram tem perfil próprio: não herda o login
    const g = await broker.verify('instagram-tuco') as { state: string };
    assert.equal(g.state, 'aguardando_login');
  } finally { await broker.shutdown(); }
});

test('identidade diferente do cadastro: estado de erro e o funcionário não consegue agir na conta', async () => {
  const { broker } = setup({ 'instagram-aurora': 'auroraexemplo' });
  try {
    await broker.connect('instagram-aurora');
    await chefeLogs(broker, 'outra.conta');
    await until(() => broker.view('instagram-aurora').state === 'erro');
    assert.match(broker.view('instagram-aurora').detail, /outra\.conta.*cadastro é @auroraexemplo/);
    const t = broker.issueToken('s1');
    assert.equal(broker.sessionForToken(t), 's1');
    await assert.rejects(broker.call('s1', 'abrir_conta', { conta: 'instagram-aurora', etapa: 'pesquisar' }), /diferente do cadastro/);
  } finally { await broker.shutdown(); }
});

test('porta de publicação: botão final só pela ferramenta publicar, texto no editor, intenção antes do clique, conferência do post e sem segundo envio', async () => {
  const { broker, calls } = setup({ 'instagram-aurora': 'auroraexemplo' });
  try {
    await broker.connect('instagram-aurora'); await chefeLogs(broker, 'auroraexemplo');
    await until(() => broker.view('instagram-aurora').state === 'verificada');
    const opened = await broker.call('s1', 'abrir_conta', { conta: 'instagram-aurora', etapa: 'publicar', url: `${base}/compose` });
    assert.match(opened, /@auroraexemplo/);
    await assert.rejects(broker.call('s1', 'clicar', { alvo: { papel: 'button', nome: 'Publicar' } }), /use a ferramenta publicar/);
    await assert.rejects(broker.call('s1', 'publicar', { itemId: 'p1', alvo: { papel: 'button', nome: 'Publicar' } }), /texto da peça não aparece no editor/);
    assert.deepEqual(calls, [], 'nenhuma intenção gravada sem o texto no editor');
    await broker.call('s1', 'preencher', { alvo: { rotulo: 'Texto' }, texto_campo: 'Teste de peça aprovada para o site falso' });
    const r = await broker.call('s1', 'publicar', { itemId: 'p1', alvo: { papel: 'button', nome: 'Publicar' } });
    assert.match(r, /Clique confirmado/);
    assert.deepEqual(calls, ['intencao', 'clicado'], 'a intenção é gravada antes do clique');
    await assert.rejects(broker.call('s1', 'publicar', { itemId: 'p1', alvo: { papel: 'button', nome: 'Publicar' } }), /envio anterior desta peça sem confirmação/);
    const v = await broker.call('s1', 'verificar_publicacao', { itemId: 'p1', url: `${base}/p/1` }).catch(e => (e as Error).message);
    assert.match(String(v), /não é da rede desta conta/, 'link de outro domínio não serve de evidência');
  } finally { await broker.shutdown(); }
});

test('sem aprovação a publicação é recusada; clique sem confirmação vira "resultado a verificar" e bloqueia nova tentativa', async () => {
  const blocked = setup({ 'instagram-aurora': 'auroraexemplo' }, false);
  try {
    await blocked.broker.connect('instagram-aurora'); await chefeLogs(blocked.broker, 'auroraexemplo');
    await until(() => blocked.broker.view('instagram-aurora').state === 'verificada');
    await blocked.broker.call('s1', 'abrir_conta', { conta: 'instagram-aurora', etapa: 'publicar', url: `${base}/compose` });
    await assert.rejects(blocked.broker.call('s1', 'publicar', { itemId: 'p2', alvo: { papel: 'button', nome: 'Publicar' } }), /não está aprovada/);
  } finally { await blocked.broker.shutdown(); }
  silentPublish = true;
  const { broker, calls } = setup({ 'instagram-aurora': 'auroraexemplo' });
  try {
    await broker.connect('instagram-aurora'); await chefeLogs(broker, 'auroraexemplo');
    await until(() => broker.view('instagram-aurora').state === 'verificada');
    await broker.call('s1', 'abrir_conta', { conta: 'instagram-aurora', etapa: 'publicar', url: `${base}/compose` });
    await broker.call('s1', 'preencher', { alvo: { rotulo: 'Texto' }, texto_campo: 'Teste de peça aprovada para o site falso' });
    const r = await broker.call('s1', 'publicar', { itemId: 'p3', alvo: { papel: 'button', nome: 'Publicar' } });
    assert.match(r, /resultado a verificar/);
    assert.deepEqual(calls, ['intencao', 'a_verificar']);
    await assert.rejects(broker.call('s1', 'publicar', { itemId: 'p3', alvo: { papel: 'button', nome: 'Publicar' } }), /sem confirmação/);
    await assert.rejects(broker.call('s1', 'verificar_publicacao', { itemId: 'p3', nao_encontrado: true }), /anexe a captura/);
    const shot = await broker.call('s1', 'capturar_tela', { nome: 'perfil' });
    const file = /Captura salva: (.+)$/.exec(shot)![1];
    await broker.call('s1', 'verificar_publicacao', { itemId: 'p3', nao_encontrado: true, evidencia: file });
    assert.deepEqual(calls.at(-1), 'nao_encontrado');
  } finally { silentPublish = false; await broker.shutdown(); }
});

test('assumir controle pausa o funcionário; ao devolver, ele precisa reler a página antes de agir', async () => {
  const { broker } = setup({ 'instagram-aurora': 'auroraexemplo' });
  try {
    await broker.connect('instagram-aurora'); await chefeLogs(broker, 'auroraexemplo');
    await until(() => broker.view('instagram-aurora').state === 'verificada');
    await broker.call('s1', 'abrir_conta', { conta: 'instagram-aurora', etapa: 'preparar', url: `${base}/compose` });
    await broker.control('instagram-aurora', true);
    assert.equal(broker.view('instagram-aurora').manual, true);
    let done = false;
    const pending = broker.call('s1', 'ler_pagina', {}).then(t => { done = true; return t; });
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(done, false, 'o comando espera enquanto o Chefe está no controle');
    await broker.control('instagram-aurora', false);
    const page = await pending;
    assert.match(page, /Publicar/);
    // o ler_pagina acima já foi a releitura; um novo controle exige reler de novo antes de clicar
    await broker.control('instagram-aurora', true); await broker.control('instagram-aurora', false);
    await assert.rejects(broker.call('s1', 'clicar', { alvo: { rotulo: 'Texto' } }), /leia a página/);
  } finally { await broker.shutdown(); }
});

test('motor "seu Edge": conta já logada no navegador do Chefe é verificada sem login novo; a HQ fecha só a aba dela', async () => {
  const { chromium } = await import('playwright-core');
  // "Edge do Chefe": um navegador já aberto e logado no site falso, com uma aba dele.
  const chefe = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await chefe.newContext();
  const hisTab = await ctx.newPage();
  await hisTab.goto(`${base}/login`);
  await hisTab.getByLabel('Usuário').fill('auroraexemplo');
  await hisTab.getByRole('button', { name: 'Entrar' }).click();
  await hisTab.waitForURL(`${base}/`);
  const dir = tempDir('hq-nav-ext-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'b') });
  const account = (slot: SocialSlotId) => ({ slot, network: slotDef(slot).network, label: slotDef(slot).label, declared: { handle: slot === 'instagram-aurora' ? 'auroraexemplo' : 'tucoexemplo', profileUrl: null, source: 'chefe', confirmed: true, toCreate: false, at: 1 } } as unknown as SocialAccount);
  const content = { folder: () => dir } as unknown as ContentGate;
  const broker = new BrowserBroker({ db, profilesRoot: path.join(dir, 'perfis'), account, content, notify: () => {}, sessionLabel: () => 'Caio', onChange: () => {}, log: { info: () => {}, warn: () => {} }, networks: { instagram: fakeNet() }, engine: 'extensao', attach: async () => chefe });
  try {
    const v = await broker.connect('instagram-aurora') as { state: string; detectedHandle: string };
    assert.equal(v.state, 'verificada'); assert.equal(v.detectedHandle, 'auroraexemplo');
    // a outra conta do Instagram não está logada no navegador: a HQ não finge que está
    const g = await broker.verify('instagram-tuco') as { state: string; detail: string };
    assert.equal(g.state, 'erro', 'o navegador está em @auroraexemplo, não em @tucoexemplo');
    await broker.shutdown();
    assert.equal(hisTab.isClosed(), false, 'a aba do Chefe continua aberta');
    assert.equal(chefe.isConnected(), true, 'o navegador do Chefe não é fechado pela HQ');
  } finally { await broker.shutdown(); await chefe.close(); }
});

test('pesquisa no Edge do Chefe: lê a rede sem abrir conta nem conferir @, só leitura, e a conta nunca conferida é conferida na hora', async () => {
  const fs = await import('node:fs');
  const { chromium } = await import('playwright-core');
  const chefe = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await chefe.newContext();
  const hisTab = await ctx.newPage();
  await hisTab.goto(`${base}/login`);
  await hisTab.getByLabel('Usuário').fill('auroraexemplo');
  await hisTab.getByRole('button', { name: 'Entrar' }).click();
  await hisTab.waitForURL(`${base}/`);
  const dir = tempDir('hq-nav-pesq-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'b') });
  const account = (slot: SocialSlotId) => ({ slot, network: slotDef(slot).network, label: slotDef(slot).label, declared: { handle: slot === 'instagram-aurora' ? 'auroraexemplo' : 'tucoexemplo', profileUrl: null, source: 'chefe', confirmed: true, toCreate: false, at: 1 } } as unknown as SocialAccount);
  const content = { folder: () => dir } as unknown as ContentGate;
  const notes: string[] = [];
  const broker = new BrowserBroker({ db, profilesRoot: path.join(dir, 'perfis'), account, content, notify: (_s, _l, t) => notes.push(t), sessionLabel: () => 'Caio', onChange: () => {}, log: { info: () => {}, warn: () => {} }, networks: { instagram: fakeNet() }, engine: 'extensao', attach: async () => chefe, researchSites: { '127.0.0.1': 'Teste' } });
  try {
    assert.equal(broker.view('instagram-aurora').state, 'cadastrada', 'conta nunca conferida');
    // lê a rede sem conta nenhuma
    const feed = await broker.call('caio', 'pesquisar', { url: `${base}/feed` });
    assert.match(feed, /Pesquisa · Teste/); assert.match(feed, /centralizar uma div/);
    assert.equal(broker.view('instagram-aurora').state, 'cadastrada', 'pesquisar não mexe no estado das contas');
    // fora das redes liberadas: recusa
    await assert.rejects(broker.call('caio', 'pesquisar', { url: `http://localhost:${new URL(base).port}/feed` }), /abre só Teste/);
    // só leitura: curtir e repostar são recusados
    await assert.rejects(broker.call('caio', 'pesquisar_clicar', { alvo: { papel: 'button', nome: 'Curtir' } }), /só leitura/);
    await assert.rejects(broker.call('caio', 'pesquisar_clicar', { alvo: { testid: 'retweet' } }), /só leitura/);
    // link para fora: volta para a pesquisa
    const fora = await broker.call('caio', 'pesquisar_clicar', { alvo: { papel: 'link', nome: 'site externo' } });
    assert.match(fora, /fora das redes da pesquisa/);
    // abrir uma publicação
    const post = await broker.call('caio', 'pesquisar_clicar', { alvo: { papel: 'link', nome: 'abrir post' } });
    assert.match(post, /continua difícil em 2026/);
    // captura da referência
    const cap = await broker.call('caio', 'pesquisar_capturar', { nome: 'post-div' });
    const file = /Captura salva: (.+)$/.exec(cap)![1];
    assert.ok(file.includes(path.join('radar', 'capturas')) && fs.existsSync(file));
    // página de login: diz a verdade (não logado), sem entrar em conta
    assert.match(await broker.call('caio', 'pesquisar', { url: `${base}/login` }), /pediu login/);
    // outra sessão não pega a aba de pesquisa no meio
    await assert.rejects(broker.call('bia', 'pesquisar', { url: `${base}/feed` }), /aba de pesquisa está com Caio/);
    // conta nunca conferida: a HQ confere no Edge na hora, sem mandar o Chefe "fazer login"
    const opened = await broker.call('bia', 'abrir_conta', { conta: 'instagram-aurora', etapa: 'preparar' });
    assert.match(opened, /Conta aberta: .*@auroraexemplo/);
    assert.equal(broker.view('instagram-aurora').state, 'verificada');
    // a conta que não está logada no Edge: mensagem verdadeira (não "precisa do login do Chefe")
    await assert.rejects(broker.call('bia', 'abrir_conta', { conta: 'instagram-tuco', etapa: 'preparar' }), /diferente do cadastro/);
    assert.ok(!notes.some(n => /precisa do login do Chefe/.test(n)));
    await broker.call('caio', 'fechar', {});
    await broker.shutdown();
    assert.equal(hisTab.isClosed(), false, 'a aba do Chefe continua aberta');
    assert.equal(ctx.pages().length, 1, 'só a aba do Chefe sobrou');
  } finally { await broker.shutdown(); await chefe.close(); }
});
