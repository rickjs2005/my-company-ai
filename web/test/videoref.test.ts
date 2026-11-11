// Referência de vídeo no campo de pedido: o link é reconhecido, a instrução decide o caminho sugerido e o perfil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCE_INTENT, VIDEO_LINK, parseLinks, roleOf, slotFromText, splitLink, videoIntent } from '../src/shell/social/VideoRefComposer';
import { videoRefs } from '../src/shell/social/VideoRefCards';

test('link no meio do texto vira referência; o resto é a instrução', () => {
  assert.deepEqual(splitLink('quero um vídeo inspirado neste para o Tuco Dev https://www.tiktok.com/@a/video/123?x=1.'), { url: 'https://www.tiktok.com/@a/video/123?x=1', instruction: 'quero um vídeo inspirado neste para o Tuco Dev' });
  assert.deepEqual(splitLink('https://www.instagram.com/reel/DfLvnNjBXi1/'), { url: 'https://www.instagram.com/reel/DfLvnNjBXi1/', instruction: null });
  assert.equal(splitLink('sem link nenhum').url, null);
});

test('instrução de produzir: "quero um vídeo inspirado neste" produz; só o link ou "olha isso" analisa', () => {
  assert.ok(PRODUCE_INTENT.test('quero um vídeo inspirado neste para o Tuco Dev'));
  assert.ok(PRODUCE_INTENT.test('faz uma versão nossa disso'));
  assert.ok(PRODUCE_INTENT.test('cria um reel parecido'));
  assert.ok(!PRODUCE_INTENT.test('olha que interessante esse'));
  assert.ok(!PRODUCE_INTENT.test('o que vocês acham?'));
  assert.equal(slotFromText('para o Tuco Dev'), 'instagram-tuco');
  assert.equal(slotFromText('versão para a Aurora'), 'instagram-aurora');
  assert.equal(slotFromText('sem perfil'), null);
});

test('cartões de vídeo: só referências com vídeo e não descartadas, mais recente primeiro', () => {
  const r = (id: string, at: number, status = 'nova', video = true) => ({ id, status, video: video ? { updatedAt: at } : null }) as never;
  const c = { radar: [r('a', 1), r('b', 3), r('c', 2, 'descartada'), r('d', 9, 'nova', false)] } as never;
  assert.deepEqual(videoRefs(c).map(x => x.id), ['b', 'a']);
});

// O pedido real do Chefe em 05/11 (três links: a piada, o áudio e o estilo), copiado como ele escreveu.
const CHEFE = 'https://www.tiktok.com/@o__maloqueiro/video/7685911412610321685?is_from_webapp=1&sender_device=pc. queria criar um video igual esse só que codigo, olha o que esse codigo faz e ai parecer a frase da mulher,ela reproduzi um som que é essa pedrada aqui,ai botar para rodar ai vem o som.com python rodando e aparecendo a frase https://www.tiktok.com/@thinker_43/video/7695619685718461702?is_from_webapp=1&sender_device=pc pode ser esse audio,https://www.tiktok.com/@dev.pedroca/video/7699591974520704276?is_from_webapp=1&sender_device=pc esse estilo o video';

test('pedido com três links: o primeiro é a base, o segundo é o áudio e o terceiro o estilo; a instrução cita cada um e pede produção', () => {
  const { links, instruction } = parseLinks(CHEFE);
  assert.deepEqual(links.map(l => l.role), ['base', 'audio', 'estilo']);
  assert.match(links[0].url, /@o__maloqueiro\/video\/7685911412610321685\?is_from_webapp=1&sender_device=pc$/);
  assert.equal(links[1].note, 'pode ser esse audio'); assert.equal(links[2].note, 'esse estilo o video');
  assert.match(instruction!, /^\[vídeo 1\] queria criar um video igual esse/);
  assert.match(instruction!, /\[vídeo 2\] pode ser esse audio, ?\[vídeo 3\] esse estilo o video$/);
  assert.deepEqual(videoIntent(CHEFE, null), { active: true, produce: true });
});

test('link de artigo não vira referência de vídeo; papel pelo texto perto do link; anexo conta como referência', () => {
  assert.deepEqual(parseLinks('lê isso https://blog.exemplo.com/post-sobre-ia e me diz').links, []);
  assert.deepEqual(videoIntent('olha https://blog.exemplo.com/a', null), { active: false, produce: false });
  assert.equal(roleOf('usa essa música'), 'audio'); assert.equal(roleOf('nesse estilo de edição'), 'estilo'); assert.equal(roleOf(null), 'referencia');
  assert.ok(VIDEO_LINK.test('https://www.instagram.com/reel/DfLvnNjBXi1/')); assert.ok(VIDEO_LINK.test('https://x.com/fulano/status/123'));
  assert.ok(!VIDEO_LINK.test('https://www.instagram.com/tucoexemplo/'));
  // Áudio citado ANTES do link ("o áudio é este: <link>") também vale.
  const b = parseLinks('faz um reel igual https://www.tiktok.com/@a/video/1 com o áudio deste https://www.tiktok.com/@b/video/2');
  assert.deepEqual(b.links.map(l => l.role), ['base', 'audio']);
  assert.equal(videoIntent('quero um vídeo assim', new File([], 'x.mp4')).active, true);
});

test('Mesa esconde a referência cuja peça foi para a lixeira; o Radar continua mostrando', () => {
  const r = (id: string, stage: string) => ({ id, status: 'nova', video: { updatedAt: 1, stage } }) as never;
  const c = { radar: [r('a', 'revisar'), r('b', 'lixeira')] } as never;
  assert.deepEqual(videoRefs(c, { hideTrashed: true }).map(x => x.id), ['a']);
  assert.deepEqual(videoRefs(c).map(x => x.id).sort(), ['a', 'b']);
});
