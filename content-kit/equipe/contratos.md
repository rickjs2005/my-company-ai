# Contratos de saída (o que a HQ importa)

A HQ só mostra no Radar, no Calendário e em Resultados o que vier destes arquivos JSON, no caminho que a tarefa indicar,
e só depois de validar. JSON inválido ou campo obrigatório ausente vira "falhou" com o motivo, e nada é inventado no lugar.
Escreva JSON puro (UTF-8, sem comentários). Datas em ISO (`2026-11-02` ou `2026-11-02T09:30:00-03:00`).

Contas válidas em `slot`: `instagram-aurora`, `instagram-tuco`, `threads`, `tiktok`, `linkedin`, `x`, `pinterest`, ou `null`.

## 1. Radar da gringa (`radar/<rodada>/oportunidades.json`)

```json
{
  "coverage": "o que foi consultado de fato (redes, sites, buscas) e o que estava bloqueado, com as mensagens reais",
  "sources": [
    { "source": "instagram", "state": "acessada | parcial | bloqueada", "detail": "o que abriu e o que bloqueou", "queries": ["programmer humor"] },
    { "source": "tiktok", "state": "...", "detail": "...", "queries": [] },
    { "source": "x", "state": "...", "detail": "...", "queries": [] },
    { "source": "reddit", "state": "...", "detail": "...", "queries": [] }
  ],
  "summary": "duas a quatro frases",
  "nothingRelevant": false,
  "opportunities": [
    {
      "kind": "achado | padrao | hipotese",
      "platform": "instagram | tiktok | x | reddit",
      "sourceUrl": "https://... (link do post)",
      "postId": "id do post quando a URL tiver",
      "author": "@handle ou u/nome",
      "sourceName": "conta ou subreddit",
      "language": "en",
      "region": null,
      "publishedAt": "ISO ou como a plataforma mostra (\"2d ago\"); null se não mostra",
      "consultedAt": "2026-11-03T20:15:00-03:00 (data e hora reais da coleta)",
      "metrics": [{ "name": "views", "value": 1200000, "raw": "1.2M" }],
      "inspected": "imagem | texto | video_parcial | video_sem_audio | video_completo_audio",
      "observed": "o que foi visto: abertura, progressão, animação, virada, encerramento",
      "subject": "assunto em uma linha",
      "summaryPt": "resumo em português",
      "context": "contexto da publicação",
      "whyInteresting": "por que interessa ao nosso público",
      "popularity": "sinal observado (números e idade do post)",
      "popularityLimit": "limitação desse sinal",
      "evidence": "referencia | tendencia | hipotese | nao_verificado",
      "window": "24-48h | 7d | 30d | antiga",
      "examples": [{ "url": "https://...", "author": "@outro", "platform": "tiktok", "metrics": "texto", "sameVideo": false }],
      "slot": "instagram-tuco | instagram-aurora | threads",
      "format": "reel | carrossel | imagem | threads",
      "adaptation": "ideia concreta em português para esse perfil (o que muda), preservando o mecanismo ou a piada",
      "fit": "por que serve para o público desse perfil",
      "opening": "abertura proposta",
      "material": "o que precisamos ter, gravar ou desenhar",
      "effort": "baixo | medio | alto",
      "audio": "nome do áudio visto e o aviso de conferir a permissão no Instagram; null se não envolve",
      "priority": 1,
      "reason": "por que é prioridade"
    }
  ]
}
```

Regras que a HQ aplica ao importar:

- Até três itens com `priority` 1, 2 e 3; os demais com `priority: null`.
- `padrao` exige criadores diferentes (autor + `examples` com `sameVideo: false`); sem isso vira `achado`, e `tendencia`
  sem padrão vira `referencia`.
- Mesmo post (URL normalizada ou `postId`) de uma rodada anterior **atualiza** a referência existente; não cria cartão.
- `slot` fora dos destinos no foco é tirado (a ideia fica no Radar, sem destino).
- `sources` atualiza o acesso real de cada fonte mostrado na tela (bloqueio de uma fonte não para as outras).
- Depois da rodada, as prioridades dos destinos no foco vão para a produção até a capacidade (3 ideias do Radar ao mesmo
  tempo; com 6 ou mais peças esperando a revisão do Chefe, nada novo entra). As outras ficam no Radar.
- O formato antigo (`signals`, `interpretation`, `proposal`) continua aceito.
- Sem nada pertinente: `nothingRelevant: true`, `opportunities: []` e o motivo em `summary`.

## 1b. Análise de referência do Chefe (`radar/entrada/<referência>/analise.json`)

```json
{
  "summary": "o que é a referência e o que ela permite analisar",
  "coverage": "o que foi aberto (arquivos, link) e o que não deu para verificar (áudio, autoria, métricas...)",
  "reference": {
    "subject": "assunto",
    "consultedAt": "2026-11-03T20:15:00-03:00",
    "evidence": "nao_verificado",
    "inspected": "captura | imagem | video_parcial | video_completo_audio | texto",
    "observed": "estrutura visual observada (o que está na imagem ou no vídeo)",
    "summaryPt": "resumo",
    "whyInteresting": "o mecanismo ou a piada que vale aproveitar",
    "popularity": "sem métrica observada (captura de tela)",
    "popularityLimit": "o que a captura não comprova",
    "slot": "instagram-tuco",
    "format": "reel",
    "adaptation": "versão própria em português: o que muda e o que se preserva (para vídeo, a sequência de cenas)",
    "opening": "abertura proposta",
    "material": "o que precisamos",
    "effort": "medio",
    "reason": "hipótese editorial"
  },
  "produce": true
}
```

Com `produce: true` (padrão) e um destino no foco, a HQ cria a peça ligada à referência (mesmo sem link original) e manda
para a produção.

## 1c. Análise de referência de vídeo (`radar/entrada/<data-hora>-video-<origem>/analise-video.json`)

A HQ inspeciona o vídeo antes (página do post, mídia pública, cortes, folhas de quadros com a marcação de tempo, volume,
silêncios e transcrição automática) e manda as folhas ANEXADAS como imagem no pedido, mais `evidencias.md` na mesma pasta.

```json
{
  "nivel": "o nível que a HQ informou (ex.: vídeo inteiro em quadros, sem áudio analisado)",
  "ideiaCentral": "uma frase",
  "publico": "público aparente",
  "promessa": "o que o vídeo promete a quem assiste",
  "estrutura": [
    { "parte": "abertura", "tempo": "00:00–00:02", "observado": "o que os quadros mostram" },
    { "parte": "progressao", "tempo": "00:02–00:10", "observado": "..." },
    { "parte": "virada", "tempo": "00:10–00:12", "observado": "..." },
    { "parte": "encerramento", "tempo": "00:12–00:14", "observado": "..." }
  ],
  "visual": { "enquadramento": "...", "planos": "cortes e duração medidos (evidencias.md)", "movimento": "o que muda entre quadros", "transicoes": "só as que os quadros mostram" },
  "recursos": "como animação, camadas, demonstração e texto ajudam a explicar ou divertir",
  "som": { "fala": "da transcrição (ou 'sem fala reconhecida')", "musica": "não ouvida", "efeitos": "não ouvidos" },
  "adaptar": ["o mecanismo que vale levar"],
  "naoCombina": ["o que não serve para a nossa marca"],
  "materiais": ["o que precisamos ter ou criar"],
  "observacoes": ["fato visto na referência, com tempo quando houver"],
  "hipoteses": ["ideia criativa nossa (não é fato da referência)"],
  "abordagens": [
    { "titulo": "...", "perfil": "instagram-tuco", "descricao": "...", "esforco": "baixo | medio | alto" },
    { "titulo": "...", "perfil": "instagram-aurora", "descricao": "...", "esforco": "..." }
  ],
  "recomendada": { "titulo": "...", "resumo": "a abordagem recomendada em duas ou três frases", "motivo": "por quê", "esforco": "medio" }
}
```

Regras: marcação de tempo só onde os quadros ou as evidências mostram; quadros isolados não provam fluidez; transcrição não
prova música, efeitos nem mixagem; não descreva cortes, áudio ou desfecho pela legenda do post. Vídeo enviado pelo Chefe é
referência: não chame de tendência nem de prova de crescimento. Até duas abordagens.

Pedido com mais de um vídeo ("igual a este", "pode ser este áudio", "neste estilo"): o vídeo 1 é a base e os outros vêm
com o papel que o Chefe deu (áudio, estilo, outra referência), cada um com a pasta `extra-N-<papel>/` e o próprio
`evidencias.md`. Acrescente ao JSON:

```json
{
  "outros": [
    { "video": 2, "link": "https://...", "papel": "audio", "comoUsar": "as falas e os tempos: 00:00.4 'Eu não gosto daqui' ...", "confere": true },
    { "video": 3, "link": "https://...", "papel": "estilo", "comoUsar": "o que levar do visual (tipografia, cor, câmera, ritmo) e o que não", "confere": true }
  ]
}
```

`confere: false` quando o papel que o Chefe deu não bate com o vídeo (diga o porquê em `comoUsar`).

Quem analisa é o Diretor de Vídeo (sem ele, o pesquisador). Além dos quadros da HQ, ele recebe os quadros da skill Watch
(`wNN-MMmSSs.jpg`, o tempo no nome) e o relatório dela em `watch/relatorio.md`; escreve também `direcao.md` (roteiro curto
e storyboard da versão recomendada) e acrescenta ao JSON as técnicas no formato da seção 1e:

```json
{ "tecnicas": [ { "slug": "...", "nome": "...", "categoria": "...", "evidencia": "observado | inferido", "onde": "00:02–00:04", "comoSabemos": "..." } ] }
```

## 1e. Estudo da Academia de Vídeo (`academia/estudos/<data-hora>-<origem>/estudo.json`)

Quando o Chefe manda um vídeo para a equipe estudar ("estudem esse vídeo", "aprendam essa técnica"), o Diretor de Vídeo grava,
na pasta do estudo: `analise.md` (formato do Video Analyzer + "Direção de vídeo"), `licao.md` (a aula), `analise-video.json`
(seção 1c) e este arquivo. Não é peça: nada vai para o Mural nem para publicação.

```json
{
  "ideiaCentral": "o que faz o vídeo funcionar, em uma frase",
  "resumoLicao": "a lição em uma frase (vai para o índice da Academia)",
  "tecnicas": [
    {
      "slug": "texto-que-salta-no-impacto",
      "nome": "Texto que salta no impacto",
      "categoria": "animacao | transicao | corte | tipografia | som | ritmo | camera | composicao | narrativa | cor | efeito | outro",
      "evidencia": "observado | inferido",
      "onde": "00:02–00:04",
      "comoSabemos": "o quadro w03 (00:02) mostra o título a 60% e o w04 (00:03) a 110%; a HQ mediu corte em 00:03.1",
      "oQueE": "o que é, em uma ou duas frases",
      "comoFazer": [
        { "ferramenta": "remotion", "passos": "spring() com damping 12 na escala de 0,6 a 1,1 e volta a 1 em 8 quadros; texto 120 px" },
        { "ferramenta": "ffmpeg", "passos": "..." }
      ],
      "armadilhas": ["exagerar a escala e cortar o texto na margem"]
    }
  ],
  "exercicios": [
    { "titulo": "Abertura com texto que salta", "papel": "video", "equipe": "tuco-dev", "tecnicas": ["texto-que-salta-no-impacto"],
      "instrucoes": "o que fazer, com o assunto nosso e os valores da lição", "entrega": "video.json com 3 a 5 cenas (a HQ renderiza)" },
    { "titulo": "Roteiro e storyboard com a técnica", "papel": "criador", "equipe": "aurora", "tecnicas": ["..."], "instrucoes": "...", "entrega": "roteiro.md e storyboard.md" },
    { "titulo": "Checklist da técnica", "papel": "revisor", "equipe": null, "tecnicas": ["..."], "instrucoes": "...", "entrega": "checklist.md" }
  ]
}
```

Regras: `evidencia` "observado" só com quadro, medida ou transcrição que mostre (diga qual em `comoSabemos`); o resto é
"inferido". Use o mesmo `slug` de uma técnica que já está em `academia/INDICE.md`. `papel`: video, criador, revisor,
coordenador ou pesquisador; `equipe`: tuco-dev, aurora ou null. De 2 a 5 exercícios, pequenos (5 a 12 s), com material
e assunto nossos. `ferramenta`: remotion, ffmpeg, gsap, css, edicao ou outro (nada pago).

## 1f. Resultado de exercício (`academia/estudos/<estudo>/exercicios/<eN-nome>/resultado.json`)

```json
{
  "resumo": "o que fiz e qual técnica apliquei, onde",
  "arquivos": ["video.json", "storyboard.md"],
  "aprendi": "o que ficou claro fazendo",
  "duvidas": "o que não consegui ou não entendi (ou null)"
}
```

Caminhos relativos à pasta do exercício (ou absolutos dentro da pasta de conteúdo). No de edição, a HQ renderiza o
`video.json` em `exercicio.mp4`, com `capa.png` e um quadro por cena em `quadros/`.

## 1g. Correção dos exercícios (`academia/estudos/<estudo>/correcao.json`)

```json
{
  "resumo": "como a equipe foi, em duas frases",
  "exercicios": [ { "id": "e1", "veredito": "ok | ajustar", "comentario": "o que funcionou e o que corrigir, citando a técnica e a cena" } ],
  "tecnicas": [ { "slug": "texto-que-salta-no-impacto", "armadilhas": ["erro que apareceu nos exercícios"] } ]
}
```

Grave também `correcao.md` (curto, para a equipe). A HQ junta o veredito e as armadilhas às fichas das técnicas.

## 2. Semana (`calendario/semana-<segunda>/calendario.json`)

```json
{
  "weekStart": "2026-11-02",
  "capacity": "hipótese de capacidade da semana (ex.: 3 peças-base + notas do X)",
  "summary": "o que a semana tenta",
  "items": [
    {
      "baseId": "b1",
      "baseTitle": "peça-base comum (projeto ou tema)",
      "date": "2026-11-04",
      "slot": "instagram-aurora",
      "format": "carrossel | reel (roteiro) | post | thread | pin | nota X",
      "objective": "objetivo desta peça",
      "title": "título de trabalho",
      "brief": "o que o criador deve fazer",
      "sources": ["https://..."],
      "files": ["C:\\caminho\\real\\do\\material ou descrição do que falta"],
      "material": "pronto | gravar | editar | nao_precisa",
      "owner": "criador",
      "skill": "rede-instagram",
      "reviewCriteria": "como o revisor decide se está bom",
      "radarId": null
    }
  ]
}
```

## 3. Peça (`<pasta da peça>/entrega.json`, com os arquivos ao lado)

```json
{
  "itemId": "id da peça na HQ",
  "network": "instagram | threads | tiktok | linkedin | x | pinterest",
  "files": ["peca.md", "pin.html"],
  "text": "texto exato a publicar (legenda, post ou roteiro resumido)",
  "title": "título (Pinterest) ou null",
  "description": "descrição (Pinterest) ou null",
  "board": "pasta sugerida (Pinterest) ou null",
  "destinationUrl": "URL real do projeto (Pinterest) ou null",
  "translation": "tradução em português para revisão (X) ou null",
  "sources": [{ "url": "https://...", "what": "o que esta fonte sustenta" }],
  "needs": ["o que falta gravar ou editar"],
  "nextStep": "próximo passo concreto"
}
```

## 3b. Carrossel (`<pasta da peça>/carrossel.json`)

Para todo formato de carrossel (Instagram Aurora, Instagram Tuco Dev, documento do LinkedIn). Você escreve o texto de cada
slide; a HQ desenha as imagens 1080×1350 na identidade da marca do perfil da peça e grava `slides/01.png`, `slides/02.png`…
Você não desenha nem roda nada. De 2 a 10 slides. Texto que não couber encolhe a letra; no limite vira erro para você encurtar.

```json
{
  "marca": "tuco-dev | aurora",
  "slides": [
    { "tipo": "capa", "kicker": "Ep. 1 · programação explicada", "titulo": "O que é uma linguagem de", "destaque": "programação?", "texto": "subtítulo curto (opcional)" },
    { "tipo": "texto", "titulo": "O computador só entende 0 e 1", "destaque": "0 e 1", "texto": "Até 3 linhas.\n\nLinha em branco separa parágrafos.", "fonte": "opcional" },
    { "tipo": "imagem", "titulo": "O site no ar", "imagem": "material/captura-home.webp", "imagemLegenda": "versão celular", "texto": "uma linha sobre o que a imagem prova" },
    { "tipo": "lista", "titulo": "Três sinais de golpe", "itens": [{ "titulo": "Pressa", "detalhe": "pede para agir agora" }, { "titulo": "Link estranho" }] },
    { "tipo": "passos", "titulo": "Do texto ao programa", "itens": [{ "titulo": "Você escreve", "detalhe": "opcional" }, { "titulo": "Um programa traduz" }] },
    { "tipo": "comparacao", "titulo": "Frontend × backend", "colunas": [{ "titulo": "Frontend", "itens": ["o que você vê"] }, { "titulo": "Backend", "itens": ["o que roda no servidor"] }] },
    { "tipo": "codigo", "titulo": "Na prática", "codigo": "nome = 'Chefe'\nprint('Olá, ' + nome)", "texto": "o que o código faz" },
    { "tipo": "destaque", "titulo": "Frase forte para salvar", "carimbo": "até 3 palavras (opcional)" },
    { "tipo": "fechamento", "titulo": "Próximo episódio: lógica.", "destaque": "lógica", "cta": "frase final (Aurora: \"Fala comigo.\" se vazio)" }
  ]
}
```

- `destaque`: trecho do título pintado na cor da marca (na capa, se não estiver no título, vira a segunda linha grande).
- `imagem` (captura ou foto real, .png/.jpg/.webp): caminho relativo à pasta da peça (as cópias da HQ ficam em `material/`) ou
  dentro da pasta de conteúdo. Vale no tipo `imagem` (grande) e também em `texto`, `destaque` e `capa` da Aurora. Na Aurora
  aparece numa janela de navegador; no Tuco, como foto colada. Prova de trabalho real vale mais que slide só de texto.
  Imagem com pessoa, nome ou depoimento de cliente só entra com o OK do Chefe (registre em `needs`).
- Limites: título até ~8 palavras; `texto` até ~3 linhas; `lista`/`passos` de 2 a 6 itens; `codigo` até 14 linhas de 48 colunas.
- `fonte` aparece no rodapé do slide (obrigatória quando o slide afirma um fato). `kicker` é a linha pequena do topo.
- Primeiro slide `capa`, último `fechamento`. Sem travessão nos textos.
- Liste `carrossel.json` em `files` do `entrega.json`; a legenda do post vai em `text`.

## 3c. Vídeo (`<pasta da peça>/video.json`)

A HQ renderiza o MP4 com a composição `CenasReel` (projeto Remotion do Chefe), gera `capa.png` e um quadro de cada cena em
`quadros/`, confere o MP4 com o ffprobe (abre, 1080×1920, duração planejada) e mede o movimento de cada cena comparando
dois quadros dela. O resultado fica em `video-conferencia.json`.

```json
{
  "composicao": "CenasReel",
  "marca": "tuco-dev | aurora",
  "titulo": "Os aplicativos mudaram. O vício continuou.",
  "capa": { "cena": "revelacao" },
  "audio": { "trilha": "gerada | nenhuma | <arquivo>", "sfx": true, "voz": null, "provisorio": false, "observacao": null },
  "cenas": [
    {
      "id": "abertura", "tipo": "titulo", "duracao": 2.2,
      "mostra": "o que aparece", "acao": "o que acontece visualmente", "informacao": "o que fica claro", "transicao": "como a próxima continua",
      "texto": "Os aplicativos mudaram."
    }
  ]
}
```

Tipos de cena e campos próprios (exemplo completo, de outro assunto, em `equipe/exemplos/video-exemplo.json`; o validador da composição está copiado em `referencias/espelho/cenas/schema.ts`, só para leitura; não abra a pasta remotion-video, que fica fora da sua pasta e pede a autorização do Chefe). Campos opcionais: `fase.alvo` (índice do ícone tocado), `fase.notificacoes`, `codigo.arquivo`, `codigo.comando`, `revelacao.hora` ("03:00"), `titulo.icones` (lista de símbolos), `diagrama.titulo`; o símbolo `misterio` também existe. `efeito` aceita uma lista (ex.: ["rolagem", "notificacoes"]).

| tipo | campos | movimento |
|---|---|---|
| `titulo` | `texto`, `subtexto`, `icones` (lista de símbolos, sem rótulo) | texto entra por partes, com elemento gráfico reagindo |
| `fase` | `idade`, `rotulo`, `personagem` (crianca, adolescente, jovem, dev), `icones` [{ `simbolo`, `rotulo` }], `efeito` (toque, rolagem, vitoria, notificacoes, glitch) | ícones entram; um toque ou rolagem dispara o efeito |
| `codigo` | `linhas`, `saida`, `sucesso` | digitação, execução e a saída verdadeira do código |
| `diagrama` | `nos` [{ `id`, `rotulo`, `simbolo` }], `fluxo` [{ `de`, `para`, `rotulo` }] | nós se conectam e um pacote percorre o fluxo |
| `interface` | `titulo`, `elementos`, `clique`, `resultado` | cursor vai até o elemento, clica e o estado muda |
| `revelacao` | `antes` e `depois` (personagens: crianca, adolescente, jovem, dev; não são textos), `texto`, `icones` [{ `simbolo`, `rotulo` }], `hora` ("03:00") | o personagem `antes` vira o `depois` com glitch e troca de luz; as ferramentas nascem e se ligam |
| `encerramento` | `texto`, `cta`, `assinatura` | fechamento com a marca |
| `captura` | `arquivo` (vídeo .mp4/.mov/.webm ou imagem, relativo à pasta da peça), `inicio` (s), `encaixe` (`cobrir` ou `largura`), `recorte` {x, y, largura, altura} em frações do quadro, `faixaY`, `zoom` {de, para}, `foco` {x, y}, `brilho`, `entrada` {pretoAte, sobeAte}, `mascara` {de, ate}, `clarao`, `saida` {preto: n}, `texto`, `velocidade`, `som` | trecho de vídeo de verdade (gravação do site, take do Chefe) recortado para 9:16; `largura` põe o recorte inteiro numa faixa sobre o mesmo quadro desfocado |

Campos que valem para qualquer cena e para o vídeo inteiro:

- `fala` (em qualquer cena) + `"audio": {"voz": "gerar"}`: a HQ gera a narração com a voz aprovada do Chefe (Kokoro
  `pm_alex`, pt-BR) e põe cada fala no começo da sua cena. Se a fala não couber, a HQ alonga a cena e regrava o
  `video.json` (fica registrado na conferência e em `narracao/falas.json`). Frase curta, falada como gente fala; sigla
  escrita como se pronuncia quando precisar (ex.: "a-pê-í" se "API" soar errado).
- `frase` {texto, y, tamanho, peso, cor, sombra}: texto fixo por cima do vídeo inteiro.
- `acabamento` {filtro (CSS), vinheta (gradiente CSS), grao {opacidade, animado}, barras {topo, base, cor}}: acabamento de
  cinema. As barras ficam por cima de tudo; não ponha texto importante embaixo delas.
- `clarao` {degrade, blend, opacidade}: o clarão das cenas com `"clarao": true` (começa um quadro antes do corte).

Em `titulo.icones` os ícones são só nomes de símbolo; em `fase`, `revelacao` e `diagrama` cada ícone é um objeto com `simbolo` e `rotulo`. Destaque no texto com `*asteriscos*`. Regras: de 3 a 24 cenas, 0,8 a 15 s cada, 6 a 90 s no total; toda cena com `mostra`, `acao`, `informacao` e `transicao`
(a última pode omitir). Ação que só diz "zoom" ou "imagem parada" é recusada. Ícones são pictogramas próprios (blocos,
corrida, fruta, espada, coroa, alvo, paraquedas, play, camera, chat, coracao, musica, editor, terminal, git, ia, deploy,
banco, design, nota, navegador, api, cafe, relogio): nada de logotipo de marca. `provisorio: true` deixa a peça como
entrega parcial (falta o áudio final). Liste `video.json`, `video.mp4` e `capa.png` em `files` do `entrega.json`; a legenda
final vai em `text`.

## 3c.1 Gravar o site (`<pasta da peça>/gravacoes.json`)

Cena `captura` de um site precisa da gravação. Você não roda o navegador: escreva o `gravacoes.json` e a HQ grava antes do
render (Edge sem janela, 1440×900, tempo real, com um cursor desenhado na página), só o que falta ou ficou mais velho que
o arquivo. Só leitura: nada de enviar formulário, comprar ou entrar em conta.

```json
{
  "url": "https://olaria-cafe.vercel.app",
  "tela": { "largura": 1440, "altura": 900 },
  "gravacoes": [
    { "arquivo": "material/abertura.mp4", "segundos": 4, "passos": [{ "esperar": 4 }] },
    { "arquivo": "material/segurar.mp4", "passos": [
      { "rolar": 1, "em": 2 }, { "mover": "text=/segure/i", "em": 0.6 }, { "segurar": "text=/segure/i", "segundos": 6 }, { "esperar": 3 }
    ] }
  ]
}
```

Passos: `esperar` (s), `rolar` (0 a 1 da página, `em` s), `rolar_ate` (seletor), `mover` (cursor até o seletor),
`clicar`, `segurar` (aperta, segura `segundos` e solta), `digitar` (texto, `em` = seletor do campo). Seletor é o do
Playwright: `text=Contato`, `text=/segure/i`, `button:has-text('Abrir')`, CSS. O cursor começa fora da tela, à direita.
Cada gravação começa com a página já carregada e dura o tempo dos passos (ou `segundos`, se for maior). Para ver a página
antes, o WebFetch pede a autorização do Chefe (a tarefa espera por ela): se você já conhece a página pelas capturas e pelo
storyboard, escreva os passos direto. Se o gravador falhar, a conferência mostra o passo e o motivo: corrija o
`gravacoes.json`.
Take do Chefe (rosto, mãos, tela do celular) não dá para gravar: escreva no `nextStep` o arquivo e o que ele precisa gravar.

## 3d. Áudio de outro vídeo (`<pasta da peça>/audio-referencia.json`)

Quando o Chefe pede o áudio de outro vídeo ("pode ser esse áudio"), a HQ extrai esse áudio (`audio.m4a` na pasta do vídeo
de áudio, citada no briefing) e, depois do render, gera `video-com-audio.mp4` ao lado do `video.mp4`. O `video.mp4` fica sem
esse áudio (no `video.json`, `trilha` é `nenhuma` ou `gerada`). Monte as cenas no tempo da fala e diga onde o áudio entra:

```json
{ "arquivo": "C:\\...\\radar\\entrada\\...\\extra-2-audio\\audio.m4a", "entraEm": 3.8, "inicio": 0, "fim": 16.6, "volume": 1 }
```

`entraEm` = segundo do nosso vídeo em que o áudio começa; `inicio` e `fim` = o trecho do áudio (`fim` null = até o fim);
`volume` de 0,1 a 2. O áudio é de terceiros: publicar com ele é decisão do Chefe. Liste `video-com-audio.mp4` em `files`.

## 4. Revisão (`<pasta da peça>/revisao.json`)

```json
{
  "verdict": "aprovar | ajustar",
  "notes": "o que verificou e o que mudar",
  "checks": [{ "name": "fatos conferidos na fonte", "ok": true, "detail": "..." }]
}
```

## 5. Análise semanal (`resultados/analise-<segunda>/analise.json`)

```json
{
  "observed": ["o que os dados mostram, com métrica, período e denominador"],
  "promising": ["o que parece promissor (sinal preliminar)"],
  "adjust": ["o que ajustar"],
  "nextTest": { "hypothesis": "...", "change": "uma variável", "metric": "métrica exata", "criterion": "critério definido antes" },
  "limits": ["limites dos dados (poucos posts, métricas ausentes)"]
}
```

## 6. Transcrição de captura (`resultados/evidencias/<id>/transcricao.json`)

```json
{
  "legible": true,
  "rows": [{ "metric": "nome exato na tela", "value": 123, "unit": null, "periodStart": null, "periodEnd": null, "postUrl": null, "note": "onde aparece" }]
}
```

Valores transcritos entram como "a conferir" até o Chefe confirmar.
