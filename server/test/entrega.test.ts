// Entrega incompleta (08/11): o que volta sozinho para quem produziu e o que vira decisão do Chefe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFix } from '../src/content/service.js';

const need = (missing: string[], required = 'vídeo') => ({ required, missing, have: [] as string[] });

test('falta arquivo que a equipe produz: correção automática com o erro exato', () => {
  const r = deliveryFix(need(['o arquivo de vídeo pronto (mp4) listado na entrega', 'capa.png (listado na entrega, não existe)']), [
    { name: 'Direção do vídeo', ok: false, detail: 'video.json: cena 1: tipo desconhecido' },
    { name: 'Tamanho do texto', ok: true, detail: 'ok' },
  ]);
  assert.equal(r.chefeOnly, false);
  assert.match(r.problem, /^falta o arquivo de vídeo pronto/);
  assert.match(r.note, /capa\.png/);
  assert.match(r.note, /Direção do vídeo: video\.json: cena 1/);
  assert.doesNotMatch(r.note, /Tamanho do texto/, 'só o que falhou vai para a correção');
});

test('falta o take do Chefe: decisão dele, sem rodada automática', () => {
  const r = deliveryFix(need(['vídeo que abre no formato planejado (faltam as gravações)']), [
    { name: 'Gravações das capturas', ok: false, detail: 'faltam material/take-1.mp4, material/take-2.mp4 na pasta da peça. Take seu (rosto, mãos, tela do celular): o Chefe precisa gravar e deixar o arquivo com esse nome.' },
  ]);
  assert.equal(r.chefeOnly, true);
  assert.match(r.decision, /take que só você grava \(material\/take-1\.mp4, material\/take-2\.mp4\)/);
});

test('áudio provisório: decisão do Chefe (escolher a música ou aprovar assim)', () => {
  const r = deliveryFix(need(['áudio final (o atual é provisório: trilha gerada)']), []);
  assert.equal(r.chefeOnly, true);
  assert.match(r.decision, /Escolha a música/);
});

test('ferramenta da HQ ausente: não é culpa de quem produziu; nada volta para a equipe', () => {
  const r = deliveryFix(need(['vídeo que abre no formato planejado (o ffprobe não abriu o arquivo)']), [
    { name: 'Vídeo abre', ok: false, detail: 'o ffprobe não abriu o arquivo: spawn ffprobe ENOENT' },
  ]);
  assert.equal(r.chefeOnly, true);
  assert.match(r.decision, /A conferência da HQ não rodou/);
});
