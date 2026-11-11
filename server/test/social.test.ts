// Central de Redes: conexões independentes por conta, identidade confirmada na rede, capacidades (informadas × testadas),
// reconexão sem duplicar nem substituir, falha de rede sem perder nada, reinício revalidando e publicação idempotente.
// As redes são simuladas por um fetch falso (nenhuma chamada sai do computador).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ServerMessage } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { SocialService, bouncePageHtml } from '../src/social/service.js';
import { DpapiVault, MemoryVault } from '../src/social/vault.js';
import { parseJsonKeepingIds } from '../src/social/providers.js';

const DAY = 86_400_000;
const IG_AURORA = '17841400000000003';   // maior que 2^53: precisa chegar intacto
const IG_TUCO = '17841400000000001';
const TH_CHEFE = '25000000000000001';

interface Net { bounceOnline?: boolean; now: number; offline: boolean; expired: Set<string>; calls: string[]; posts: number; liExpiresIn: number }
function fakeFetch(net: Net): typeof fetch {
  const json = (text: string, status = 200, headers: Record<string, string> = {}) => new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (net.offline) throw new TypeError('fetch failed');
    const u = new URL(String(input)); const key = `${init?.method ?? 'GET'} ${u.host}${u.pathname}`;
    net.calls.push(key);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const tok = u.searchParams.get('access_token') ?? String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('Bearer ', '');
    if (tok && net.expired.has(tok)) return json('{"error":{"message":"Error validating access token: Session has expired","code":190}}', 400);
    if (u.host === 'aurora.example' && u.pathname === '/hq-retorno.html') return net.bounceOnline ? new Response(bouncePageHtml(), { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 });
    if (u.host === 'cdn.example') return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } });
    // Instagram
    if (key === 'POST api.instagram.com/oauth/access_token') {
      const who = body.get('code')!.replace('code-', '');
      const uid = who === 'aurora' ? IG_AURORA : who === 'tuco' ? IG_TUCO : '17841499999999999';
      return json(`{"data":[{"access_token":"short-${who}","user_id":${uid},"permissions":"instagram_business_basic,instagram_business_content_publish"}]}`);
    }
    if (key === 'GET graph.instagram.com/access_token') return json(`{"access_token":"long-${u.searchParams.get('access_token')!.replace('short-', '')}","token_type":"bearer","expires_in":5183944}`);
    if (key === 'GET graph.instagram.com/refresh_access_token') return json(`{"access_token":"${tok}-r","expires_in":5183944}`);
    if (key === 'GET graph.instagram.com/v26.0/me') {
      const who = tok.replace(/^long-/, '').replace(/-r$/, '');
      const uid = who === 'aurora' ? IG_AURORA : who === 'tuco' ? IG_TUCO : '17841499999999999';
      return json(`{"user_id":${uid},"username":"${who === 'tuco' ? 'tuco.example' : who}","name":"${who}","account_type":"Business","profile_picture_url":"https://cdn.example/${who}.jpg","id":"1"}`);
    }
    if (key === 'GET graph.instagram.com/v26.0/me/media') return json('{"data":[{"id":"9"}]}');
    if (/^GET graph\.instagram\.com\/v26\.0\/\d+\/content_publishing_limit$/.test(key)) return json('{"data":[{"quota_usage":2,"config":{"quota_total":100,"quota_duration":86400}}]}');
    // Threads
    if (key === 'POST graph.threads.com/oauth/access_token') return json(`{"access_token":"th-short","user_id":${TH_CHEFE}}`);
    if (key === 'GET graph.threads.com/access_token') return json('{"access_token":"th-long","token_type":"bearer","expires_in":5183944}');
    if (key === 'GET graph.threads.com/v1.0/me') return json(`{"id":"${TH_CHEFE}","username":"chefe.threads","name":"Chefe","threads_profile_picture_url":"https://cdn.example/th.jpg"}`);
    if (key === 'GET graph.threads.com/v1.0/me/threads') return json('{"data":[]}');
    if (key === 'GET graph.threads.com/v1.0/me/threads_publishing_limit') return json('{"data":[{"quota_usage":0,"config":{"quota_total":250}}]}');
    if (key === 'POST graph.threads.com/v1.0/me/threads') return json('{"id":"container-1"}');
    if (key === 'POST graph.threads.com/v1.0/me/threads_publish') { net.posts++; return json(`{"id":"post-${net.posts}"}`); }
    if (/^GET graph\.threads\.com\/v1\.0\/post-\d+$/.test(key)) return json('{"permalink":"https://www.threads.com/@chefe.threads/post/abc"}');
    // LinkedIn
    if (key === 'POST www.linkedin.com/oauth/v2/accessToken') return json(`{"access_token":"li-tok","expires_in":${net.liExpiresIn},"scope":"openid,profile,w_member_social"}`);
    if (key === 'GET api.linkedin.com/v2/userinfo') return json('{"sub":"aBc123","name":"Maria Silva","picture":"https://cdn.example/li.jpg"}');
    return json(`{"error":{"message":"rota não simulada: ${key}"}}`, 404);
  }) as typeof fetch;
}

function setup(opts: { db?: ReturnType<typeof openDb>; vault?: MemoryVault; net?: Net } = {}) {
  const db = opts.db ?? openDb(':memory:');
  const vault = opts.vault ?? new MemoryVault();
  const net: Net = opts.net ?? { now: Date.UTC(2026, 10, 2, 12), offline: false, expired: new Set(), calls: [], posts: 0, liExpiresIn: 60 * 86_400 };
  const msgs: ServerMessage[] = [];
  const audits: string[] = [];
  const svc = new SocialService({ db, vault, port: 4777, broadcast: m => msgs.push(m), log: { info() {}, warn() {} }, profileIds: () => ['aurora', 'tuco-dev'], audit: e => audits.push(`${e.action}:${e.entityId}`), fetch: fakeFetch(net), now: () => net.now });
  return { db, vault, net, svc, msgs, audits };
}
async function authorize(s: ReturnType<typeof setup>, slot: Parameters<SocialService['connect']>[0], code: string) {
  const { url } = await s.svc.connect(slot);
  const state = new URL(url).searchParams.get('state')!;
  return s.svc.handleCallback(new URLSearchParams({ code, state }));
}
const acct = (s: ReturnType<typeof setup>, slot: string) => s.svc.state().accounts.find(a => a.slot === slot)!;

test('IDs longos da Meta chegam intactos ao ler o JSON', () => {
  assert.deepEqual(parseJsonKeepingIds('{"user_id":17841400000000001,"n":12}'), { user_id: '17841400000000001', n: 12 });
});

test('sem app configurado o cartão pede o app; o link de autorização leva o app, o retorno HTTPS e um state com a porta', async () => {
  const s = setup();
  assert.equal(acct(s, 'instagram-aurora').status, 'needs_app');
  await assert.rejects(s.svc.connect('instagram-aurora'), /ainda não foi configurado/);
  await s.svc.saveApp('instagram', '1234567890', 'segredo-do-app-123');
  const st = s.svc.state();
  assert.equal(st.apps.find(a => a.app === 'instagram')!.configured, true);
  assert.equal(JSON.stringify(st).includes('segredo-do-app-123'), false, 'o segredo nunca vai para a interface');
  assert.equal(acct(s, 'instagram-aurora').status, 'not_connected');
  const { url } = await s.svc.connect('instagram-aurora');
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), '1234567890');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://aurora.example/hq-retorno.html');
  assert.equal(u.searchParams.get('force_reauth'), 'true');
  assert.match(u.searchParams.get('state')!, /^p4777-[0-9a-f]{36}$/);
});

test('dois Instagrams independentes; a mesma conta não entra em dois cartões; reconectar com outra conta não substitui', async () => {
  const s = setup();
  await s.svc.saveApp('instagram', '1234567890', 'segredo-do-app-123');
  const r1 = await authorize(s, 'instagram-aurora', 'code-aurora');
  assert.equal(r1.ok, true, r1.message);
  const m = acct(s, 'instagram-aurora');
  assert.equal(m.remoteId, IG_AURORA); assert.equal(m.username, 'aurora'); assert.equal(m.status, 'connected');
  assert.match(m.avatar ?? '', /^data:image\/jpeg;base64,/);
  assert.deepEqual(m.profileIds, ['aurora']);
  assert.equal(m.capabilities.authenticated.state, 'tested');
  assert.equal(m.capabilities.read.state, 'tested');
  assert.equal(m.capabilities.publish.state, 'reported', 'permissão concedida não é publicação testada');
  assert.equal(m.capabilities.publish.hqReady, false);
  assert.equal(m.capabilities.schedule.state, 'unavailable');

  const r2 = await authorize(s, 'instagram-tuco', 'code-tuco');
  assert.equal(r2.ok, true, r2.message);
  assert.equal(acct(s, 'instagram-tuco').remoteId, IG_TUCO);
  assert.equal(acct(s, 'instagram-aurora').remoteId, IG_AURORA, 'o segundo Instagram preserva o primeiro');

  // a mesma conta do Aurora não pode virar o destino Tuco (nem duplicar)
  await s.svc.disconnect('instagram-tuco');
  const dup = await authorize(s, 'instagram-tuco', 'code-aurora');
  assert.equal(dup.ok, false); assert.match(dup.message, /já é o destino "Instagram · Aurora"/);
  assert.equal(acct(s, 'instagram-tuco').remoteId, null);

  // reconectar o Aurora entrando em outra conta: recusado, nada muda
  const firstConnectedAt = acct(s, 'instagram-aurora').connectedAt;
  const other = await authorize(s, 'instagram-aurora', 'code-outra');
  assert.equal(other.ok, false); assert.match(other.message, /mesma conta/);
  assert.equal(acct(s, 'instagram-aurora').remoteId, IG_AURORA);
  // reconectar com a mesma conta: atualiza o acesso, mantém a data da primeira conexão e não cria outra linha
  s.net.now += DAY;
  const again = await authorize(s, 'instagram-aurora', 'code-aurora');
  assert.equal(again.ok, true);
  assert.equal(acct(s, 'instagram-aurora').connectedAt, firstConnectedAt);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE remote_id=?").get(IG_AURORA) as { n: number }).n, 1);
  assert.deepEqual(s.audits.filter(a => a.startsWith('conectar') || a.startsWith('reconectar')), ['conectar:instagram-aurora', 'conectar:instagram-tuco', 'reconectar:instagram-aurora']);
  // tokens nunca no banco
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM social_accounts').all());
  assert.equal(dump.includes('long-aurora'), false);
});

test('retorno inválido, vencido ou recusado não grava nada', async () => {
  const s = setup();
  await s.svc.saveApp('instagram', '1234567890', 'segredo-do-app-123');
  const bad = await s.svc.handleCallback(new URLSearchParams({ code: 'code-aurora', state: 'p4777-forjado' }));
  assert.equal(bad.ok, false);
  const { url } = await s.svc.connect('instagram-aurora');
  const state = new URL(url).searchParams.get('state')!;
  const denied = await s.svc.handleCallback(new URLSearchParams({ error: 'access_denied', error_description: 'The user denied your request.', state }));
  assert.equal(denied.ok, false);
  assert.equal(acct(s, 'instagram-aurora').remoteId, null);
  assert.match(acct(s, 'instagram-aurora').lastError ?? '', /denied/);
  // o mesmo state não vale duas vezes
  assert.equal((await s.svc.handleCallback(new URLSearchParams({ code: 'code-aurora', state }))).ok, false);
  // passou de 15 minutos
  const late = await s.svc.connect('instagram-aurora');
  s.net.now += 16 * 60_000;
  assert.equal((await s.svc.handleCallback(new URLSearchParams({ code: 'code-aurora', state: new URL(late.url).searchParams.get('state')! }))).ok, false);
});

test('Threads: estado próprio; publicar só quando mandam, uma vez por envio; leitura testada não é publicação testada', async () => {
  const s = setup();
  await s.svc.saveApp('threads', '9876543210', 'segredo-threads-123');
  const r = await authorize(s, 'threads', 'code-th');
  assert.equal(r.ok, true, r.message);
  const t = acct(s, 'threads');
  assert.equal(t.remoteId, TH_CHEFE); assert.equal(t.username, 'chefe.threads');
  assert.deepEqual(t.profileIds, [], 'Threads começa sem perfil: o Chefe escolhe depois de identificar');
  assert.equal(t.capabilities.read.state, 'tested');
  assert.equal(t.capabilities.publish.state, 'reported');
  assert.equal(t.capabilities.publish.hqReady, true);
  assert.equal(s.net.posts, 0, 'conectar nunca publica');
  // associação de perfil (só perfis que existem)
  s.svc.setProfiles('threads', ['aurora', 'inexistente']);
  assert.deepEqual(acct(s, 'threads').profileIds, ['aurora']);
  await assert.rejects(s.svc.publish('threads', 'envio-teste-0001', 'x'.repeat(501), null), /até 500 caracteres/);
  const p1 = await s.svc.publish('threads', 'envio-teste-0001', 'Teste da MilWeb HQ', null);
  assert.equal(p1.duplicate, false); assert.equal(p1.url, 'https://www.threads.com/@chefe.threads/post/abc');
  const p2 = await s.svc.publish('threads', 'envio-teste-0001', 'Teste da MilWeb HQ', null);
  assert.equal(p2.duplicate, true); assert.equal(s.net.posts, 1, 'o mesmo envio não publica duas vezes');
  const after = acct(s, 'threads');
  assert.equal(after.capabilities.publish.state, 'tested');
  assert.equal(after.lastPublish?.remotePostId, 'post-1');
  // o Instagram (sem publicação pela HQ) recusa publicar
  await s.svc.saveApp('instagram', '1234567890', 'segredo-do-app-123');
  await authorize(s, 'instagram-aurora', 'code-aurora');
  await assert.rejects(s.svc.publish('instagram-aurora', 'envio-teste-0002', 'oi', null), /não está disponível/);
});

test('verificação: sem rede preserva a conta; acesso revogado vira "reconectar"; LinkedIn avisa antes de vencer', async () => {
  const s = setup();
  await s.svc.saveApp('instagram', '1234567890', 'segredo-do-app-123');
  await authorize(s, 'instagram-aurora', 'code-aurora');
  s.net.offline = true;
  await s.svc.check('instagram-aurora', 'teste');
  let m = acct(s, 'instagram-aurora');
  assert.equal(m.status, 'connected'); assert.equal(m.lastCheckOk, false); assert.match(m.lastError ?? '', /sem resposta da rede/);
  assert.equal(m.remoteId, IG_AURORA);
  s.net.offline = false;
  s.net.expired.add('long-aurora');
  await s.svc.check('instagram-aurora', 'teste');
  m = acct(s, 'instagram-aurora');
  assert.equal(m.status, 'expired'); assert.equal(m.remoteId, IG_AURORA, 'vencido continua identificado (para reconectar a mesma conta)');
  assert.match(m.nextStep ?? '', /Reconectar/);

  s.net.liExpiresIn = 5 * 86_400;
  await s.svc.saveApp('linkedin', '86abcdefgh', 'segredo-linkedin-1');
  const r = await authorize(s, 'linkedin', 'code-li');
  assert.equal(r.ok, true, r.message);
  const li = acct(s, 'linkedin');
  assert.equal(li.status, 'expiring'); assert.equal(li.username, null, 'LinkedIn não tem @: nada é inventado');
  assert.equal(li.displayName, 'Maria Silva'); assert.equal(li.remoteId, 'aBc123');
  assert.equal(li.capabilities.read.state, 'unavailable');
  assert.equal(li.capabilities.publish.hqReady, true);
});

test('reiniciar preserva contas e associações e revalida na rede', async () => {
  const net: Net = { now: Date.UTC(2026, 10, 2, 12), offline: false, expired: new Set(), calls: [], posts: 0, liExpiresIn: 60 * 86_400 };
  const vault = new MemoryVault();
  const db = openDb(':memory:');
  const a = setup({ db, vault, net });
  await a.svc.saveApp('instagram', '1234567890', 'segredo-do-app-123');
  await authorize(a, 'instagram-aurora', 'code-aurora');
  await authorize(a, 'instagram-tuco', 'code-tuco');
  a.svc.setProfiles('instagram-tuco', ['tuco-dev', 'aurora']);
  const before = acct(a, 'instagram-aurora').lastCheckAt;
  // "reinício": outro serviço sobre o mesmo banco e o mesmo cofre
  net.now += 3 * DAY;
  const b = setup({ db, vault, net });
  await b.svc.init();
  assert.equal(acct(b, 'instagram-aurora').remoteId, IG_AURORA);
  assert.deepEqual(acct(b, 'instagram-tuco').profileIds, ['tuco-dev', 'aurora']);
  await b.svc.checkAll('início do serviço');
  assert.ok((acct(b, 'instagram-aurora').lastCheckAt ?? 0) > (before ?? 0), 'a verificação ao iniciar registra a hora');
  assert.notEqual(b.svc.state().checkedAt, null);
});

test('página de retorno: a central confere se está no ar e se é a da HQ', async () => {
  const s = setup();
  await s.svc.checkRedirect();
  assert.equal(s.svc.state().redirectCheck.ok, false);
  assert.match(s.svc.state().redirectCheck.detail, /não encontrada \(HTTP 404\)/);
  s.net.bounceOnline = true;
  await s.svc.checkRedirect();
  assert.equal(s.svc.state().redirectCheck.ok, true);
  await assert.rejects(s.svc.handle({ type: 'social.redirect.save', reqId: 'r', uri: 'http://aurora.example/x' }), /https:\/\//);
});

test('página de retorno: só repassa para a HQ local, na porta indicada no state', () => {
  const html = bouncePageHtml();
  assert.match(html, /http:\/\/127\.0\.0\.1:' \+ port \+ '\/social\/oauth\/callback/);
  assert.match(html, /noindex/);
  assert.equal(/fetch\(|XMLHttpRequest|localStorage|<script src/.test(html), false, 'não carrega nada de fora nem guarda nada');
});

test('cofre do Windows: guarda cifrado e abre de novo', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-cofre-'));
  try {
    const v = new DpapiVault(dir);
    await v.set('acct:teste', '{"accessToken":"segredo-123"}');
    const file = fs.readdirSync(dir).find(f => f.endsWith('.bin'))!;
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8').includes('segredo-123'), false, 'no disco fica cifrado');
    assert.equal(await new DpapiVault(dir).get('acct:teste'), '{"accessToken":"segredo-123"}');
    await v.delete('acct:teste');
    assert.equal(await new DpapiVault(dir).get('acct:teste'), null);
    assert.equal(v.info().ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
