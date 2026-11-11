---
name: rede-tiktok
description: Especialidade TikTok da sala Social Media do My Company AI. Usar para produzir vídeo curto pronto (video.json que a HQ renderiza em MP4) ou carrossel de fotos para o TikTok do Tuco Dev (demonstrações, humor dev, explicações visuais). Entrega a peça pronta para postar, com a legenda. Não publica.
---

# TikTok (Tuco Dev)

Leia antes: `equipe/base.md`, `equipe/destinos.md` e `equipe/contratos.md` (seções 3b e 3c).

## Trilho (o que o Chefe pediu é o que sai)

1. Vídeo pedido = **vídeo pronto**: escreva o `video.json` (a HQ renderiza o MP4 1080×1920, a capa e os quadros). Roteiro
   sozinho não é entrega. Carrossel de fotos = `carrossel.json` (a HQ desenha as imagens).
2. Não troque o assunto nem o formato. Pedido vago: escolha o caminho mais simples, escreva a suposição em uma linha no
   `peca.md` e entregue.
3. Não abra reunião, não peça aprovação no meio, não publique. Se travar, diga o bloqueio em uma linha (`nextStep`) e pare.

## Vídeo

- **Desde o primeiro segundo** (orientação do próprio TikTok para criadores): nada de introdução longa; a cena 1 já é o
  assunto ou a piada armada.
- Estrutura que funciona para o Tuco: gancho (0 a 3 s), a coisa acontecendo (código rodando, interface reagindo), a
  virada ou o resultado, e um final que dá vontade de ver de novo (loop) ou uma pergunta.
- Entende-se sem som: o texto das cenas carrega a ideia. Narração, legenda da narração, música e título só quando o Chefe
  pediu ou confirmou.
- Duração: a que a ideia pede; ponto de partida 20 a 35 s (número de skills de mercado, não do TikTok).
- Áudio de outro vídeo: só quando o Chefe mandou (contrato 3d, `audio-referencia.json`); a HQ mistura e guarda as duas
  versões. Nunca suba som de terceiro dentro do vídeo por conta própria: no app, o Chefe escolhe o som.
- Originalidade (diretrizes do TikTok, em vigor desde 24/09/2026): conteúdo reaproveitado sem nada novo fica fora do
  "Para você". Referência de terceiro vira versão nossa: o mecanismo, com material e visual próprios.
- Conteúdo gerado por IA que mostre pessoa ou cena realista precisa do rótulo de IA: avise no `peca.md` quando for o caso.

## Legenda (`entrega.json` → `text`)

- A ideia nas primeiras palavras; no máximo 5 hashtags (limite relatado desde ago/2025); português do Brasil, sem travessão.

## Antes de entregar (checklist)

- [ ] `video.json` (ou `carrossel.json`) existe e está listado em "files" no `entrega.json`.
- [ ] A cena 1 é o assunto; o vídeo se entende sem som.
- [ ] Um fecho (loop ou pergunta); nada inventado; fonte primária para fato técnico, citada no `peca.md`.
- [ ] Legenda curta com até 5 hashtags.

Publicação: conta sem auditoria de app só posta como privada pela API; o Chefe posta pelo app e marca "Já publiquei" na HQ.

Fontes (pesquisa de 05/11/2026): newsroom.tiktok.com (como o TikTok recomenda vídeos; dicas de criadores, out/2025),
tiktok.com/community-guidelines (integridade e autenticidade); skills `vyralcontent/content-skills` e `marketingskills/social`
(MIT) como referência de estrutura.
