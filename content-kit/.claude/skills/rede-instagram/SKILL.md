---
name: rede-instagram
description: Especialidade Instagram da sala Social Media do My Company AI. Usar para produzir Reel (vídeo pronto pela HQ a partir do video.json) ou carrossel (slides prontos pela HQ a partir do carrossel.json) para o Instagram Tuco Dev (tecnologia acessível e humor dev) ou o Instagram Aurora (trabalho real do Chefe). Entrega a peça pronta para postar, com a legenda. Não publica.
---

# Instagram (Tuco Dev e Aurora)

Leia antes: `equipe/base.md`, `equipe/destinos.md` (objetivo da conta) e `equipe/contratos.md` (seções 3b e 3c).
As duas contas usam esta especialidade, mas têm assunto, público e voz diferentes: confira o `slot` da tarefa.

## Trilho (o que o Chefe pediu é o que sai)

1. Entregue **o formato pedido, pronto**: Reel = `video.json` (a HQ renderiza o MP4); carrossel = `carrossel.json` (a HQ
   desenha os slides). Roteiro, lista de ideias ou pergunta de volta não é entrega.
2. Não troque o assunto, a conta nem o formato. Se o pedido estiver vago, escolha o caminho mais simples, escreva a
   suposição em uma linha no `peca.md` e entregue.
3. Uma ideia por peça. Assunto só do pedido do Chefe, do Radar ou dos projetos reais dele (nada inventado).
4. Não abra reunião, não peça aprovação no meio, não publique. Se travar, diga o bloqueio em uma linha (`nextStep`) e pare.

## Reel (vídeo pela HQ)

- **Primeiro segundo**: o assunto já aparece na tela (sem logo, sem "oi gente", sem introdução). O Instagram mostra quantos
  pulam antes de 3 s; a abertura decide.
- Entende-se sem som: o texto das cenas carrega a ideia. Legenda da narração, narração, música e título na tela só quando o
  Chefe pediu ou confirmou (preferência dele; ver `preferencias-do-chefe.md`).
- Duração: a que a ideia pede. Ponto de partida 15 a 30 s (número de skills de mercado, não da plataforma).
- Movimento que explica (código que roda e mostra a saída, interface com cursor e resultado, diagrama com o pedido indo e
  voltando). Imagem parada com zoom não é Reel.
- Fecho: um só. Para vídeo, o Chefe prefere fechar com uma pergunta, sem pitch comercial ("Fala comigo." só na Aurora e só
  quando o objetivo for contato).
- Originalidade (regra oficial do Instagram, 30/04/2026): conta que posta majoritariamente conteúdo não original sai das
  recomendações; borda, marca d'água ou crédito não bastam. Referência de terceiro vira **versão nossa**: o mecanismo, com
  material, roteiro e visual próprios. Nada do vídeo do outro dentro do nosso.

## Carrossel (slides pela HQ)

- 5 a 10 slides em 1080×1350. O slide 1 para a rolagem sozinho: promessa clara em até ~8 palavras.
- Um ponto por slide, mesmo modelo visual em todos, texto curto (o que não cabe volta como erro para você encurtar).
- Se a capa promete um número ("5 atalhos"), entregue exatamente esse número.
- Último slide: um único pedido (salvar ou mandar para alguém). Fato técnico com fonte primária, citada no `peca.md`.

## Legenda do post (`entrega.json` → `text`)

- A ideia na primeira linha (é o que aparece antes do "mais"). Sem repetir o slide 1 palavra por palavra.
- No máximo 5 hashtags (limite do Instagram desde dez/2025, segundo relato público); hashtag só diz do que o post trata.
- Português do Brasil, jeito do Chefe, sem travessão, sem cacoete de IA ("não é X, é Y", "Concorda?", "Bora?").

## Conta por conta

- **Tuco Dev (`instagram-tuco`)**: tecnologia, programação e IA explicadas sem complicar, humor de dev, experimentos.
  Indicador: envios e salvamentos.
- **Aurora (`instagram-aurora`)**: trabalho real do Chefe (antes e depois documentado, decisão de interface, bastidor,
  problema resolvido), com captura ou gravação real. Demo é chamada de demo; nada de cliente, depoimento ou número inventado.
  Não é a peça do Tuco com outro logo.

## Antes de entregar (checklist)

- [ ] O arquivo do formato existe (`video.json` ou `carrossel.json`) e o `entrega.json` lista ele em "files".
- [ ] O 1º segundo (ou o slide 1) mostra o assunto.
- [ ] Uma ideia, um fecho, nada inventado, fontes citadas no `peca.md`.
- [ ] Legenda com a ideia na 1ª linha e até 5 hashtags, sem travessão.
- [ ] Suposições e pendências escritas em uma linha cada no `peca.md`.

Fontes desta especialidade (pesquisa de 05/11/2026): creators.instagram.com/blog/rewarding-original-creators-on-instagram
(originalidade), relatos públicos sobre skip rate e limite de hashtags; skills `marketingskills/social` (MIT) e
`charlie947/social-media-skills` (MIT) como referência de estrutura.
