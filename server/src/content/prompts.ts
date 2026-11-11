// Pedidos que a HQ entrega a cada funcionário da sala de conteúdo. Cada pedido diz o que ler, o que produzir e onde gravar;
// a HQ só importa o JSON do caminho indicado. Nenhum pedido manda publicar, agendar ou falar com terceiros.
import type { ContentItem } from '@milweb-hq/protocol';
import { slotDef } from '@milweb-hq/protocol';

const RULES = 'Regras: não publique, não agende e não envie nada a ninguém; não invente @, cliente, número, data ou fonte; sem ferramenta paga. Para arquivos use Glob, Grep e Read (não use o terminal: comandos pedem autorização do Chefe). As referências de fora estão copiadas em `referencias/espelho/` (veja o LEIA-ME); fora desta pasta, leia só o que a tarefa indicar. Se faltar uma decisão que muda o resultado e que só o Chefe sabe (qual trecho, qual conta, confirmar um nome, uma letra ou um número), pergunte com a ferramenta AskUserQuestion: uma pergunta curta, com 2 a 4 opções. Ela aparece na Mesa dele e o seu tempo para enquanto ele não responde. Para o resto, decida pelo caminho mais simples e registre a suposição no peca.md.';

export function nowBrt(now: number): string {
  return new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface RadarScope {
  /** Destinos no foco (os únicos que recebem proposta). */
  active: { slot: string; label: string }[];
  /** Fontes de pesquisa ligadas (pesquisar nelas não libera produção nelas). */
  sources: { source: string; label: string; role: string }[];
  /** Referências já registradas (chave do post): a nova coleta atualiza, não duplica. */
  known: string[];
}

export function radarPrompt(o: { outputPath: string; now: number; focus?: string | null; previous: string[]; scope?: RadarScope }): string {
  const sc = o.scope;
  return [
    `Rodada do Radar da gringa. Agora: ${nowBrt(o.now)} (Brasília).`,
    '',
    'Leia antes: `equipe/funcoes/pesquisador.md`, `equipe/base.md`, `equipe/destinos.md`, `equipe/contratos.md` (seção 1) e `equipe/fontes-x.md`.',
    o.previous.length ? `Rodadas anteriores (não repita sem fato novo): ${o.previous.map(p => '`' + p + '`').join(', ')}.` : 'É a primeira rodada do Radar.',
    'Confira também `radar/entrada/` (links, capturas e exportações deixados pelo Chefe) e o material de cada equipe em `marcas/aurora/material/` e `marcas/tuco-dev/material/`.',
    o.focus ? `Foco pedido pelo Chefe nesta rodada: ${o.focus}` : '',
    '',
    sc ? `Destinos no foco (os únicos que recebem proposta): ${sc.active.map(a => `${a.label} (\`${a.slot}\`)`).join('; ')}. Outras redes estão pausadas: ideia boa para elas fica sem destino.` : '',
    sc ? `Fontes de pesquisa ligadas: ${sc.sources.map(s => `${s.label} (${s.role})`).join('; ')}. Pesquisar numa fonte não libera produção nem publicação nela.` : '',
    'Procure publicações estrangeiras (sobretudo em inglês) sobre programação, IA, ferramentas, web design, desenvolvimento, rotina freelancer, memes de dev e curiosidades tech. Pesquise por temas, criadores e formatos: o feed de uma conta só não mostra o que está em alta. Para direção de vídeo, priorize referências audiovisuais do Instagram; para pauta e contexto, combine as fontes ligadas. Posts que são só o print de uma publicação do X fazem sucesso no Instagram: quando achar um bom, registre o formato e proponha a versão nossa (texto próprio no formato de post, ou o print comentado com tradução e contexto, com crédito), nunca o repost puro.',
    'Janela: primeiro as últimas 72 h; se faltar, até 7 dias. Mais antigo só como inspiração, com window "antiga". Qualidade acima de quantidade: até cinco boas referências, até três prioridades; menos é melhor que fraco.',
    'Assista às referências decisivas quando tiver acesso e descreva abertura, progressão, animação, virada e encerramento observados; diga o que inspecionou (imagem, texto, vídeo parcial, vídeo sem áudio, vídeo completo com áudio). Não deduza ritmo pela capa nem descreva áudio que não ouviu. Likes acumulados não provam crescimento atual; "padrão" exige criadores diferentes no período (republicação do mesmo vídeo não conta). Idioma não prova país.',
    'Encontrar uma trend no TikTok não quer dizer que funcione igual no Instagram: proponha a adaptação (contexto, duração, composição, linguagem) para o perfil de destino, preservando o mecanismo ou a piada. Áudio: nunca presuma que está liberado no Instagram; diga que precisa conferir.',
    'Pesquisa nas redes: use a ferramenta pesquisar do navegador da HQ. Ela abre X, Reddit, Instagram e Threads direto no Edge do Chefe, com os logins dele, sem abrir conta nem conferir @ (abrir_conta é só para preparar, publicar e ler métricas). Monte a busca pela URL (exemplos na descrição da ferramenta), use "rolar" para carregar mais, pesquisar_clicar para abrir uma publicação e pesquisar_capturar para guardar a referência. Só leitura: nada de curtir, seguir, responder ou salvar. Uma fonte só fica "bloqueada" se a própria página pedir login ou der erro: registre a mensagem real em "sources" e siga com as outras (WebSearch/WebFetch). Uma fonte bloqueada não para a rodada.',
    sc?.known.length ? `Já registradas (se aparecerem de novo, use o mesmo link: a HQ atualiza a existente): ${sc.known.slice(0, 40).join(', ')}.` : '',
    '',
    `Grave o resultado em \`${o.outputPath}\` (JSON do contrato, seção 1, com "sources" por fonte) e um \`radar.md\` legível na mesma pasta.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Análise de uma referência enviada pelo Chefe ("Usar como referência"): estrutura, o que dá e o que não dá para afirmar, adaptação. */
export function referencePrompt(o: { outputPath: string; now: number; dir: string; files: string[]; url: string | null; text: string | null; slot: string | null; active: { slot: string; label: string }[]; radarId: string }): string {
  return [
    `Analisar uma referência enviada pelo Chefe. Agora: ${nowBrt(o.now)} (Brasília). Id no Radar: ${o.radarId}.`,
    '',
    'Leia antes: `equipe/funcoes/pesquisador.md` (Referência do Chefe), `equipe/base.md`, `equipe/destinos.md` e `equipe/contratos.md` (seção 1b).',
    `Pasta da referência: \`${o.dir}\`.`,
    o.files.length ? `Arquivos (abra cada imagem com a ferramenta Read): ${o.files.map(f => '`' + f + '`').join(', ')}.` : 'Sem arquivo.',
    o.url ? `Link enviado: ${o.url} (abra se der; se bloquear, diga).` : 'Sem link original: não procure atribuir autoria nem métricas.',
    o.text ? `Texto do Chefe: ${o.text}` : '',
    o.slot ? `Destino sugerido pelo Chefe: \`${o.slot}\`.` : `Destinos no foco: ${o.active.map(a => `${a.label} (\`${a.slot}\`)`).join('; ')}. Escolha o mais adequado.`,
    '',
    'Separe o que a referência PERMITE analisar (estrutura visual, sequência, texto, composição) do que ela NÃO comprova (áudio, transições, ritmo completo, autoria, métricas de uma captura de tela). Não atribua ao original nada que não viu. Proponha uma adaptação própria em português, reconhecível e com a nossa identidade, preservando o mecanismo ou a piada; para vídeo, já sugira a sequência de cenas (o que aparece, o que acontece, o que fica claro) e marque as escolhas como autorais.',
    `Grave \`${o.outputPath}\` (contrato, seção 1b) e um \`analise.md\` legível na mesma pasta.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

export function weekPrompt(o: { outputPath: string; now: number; weekStart: string; weekEnd: string; note?: string | null; radar: string[]; calendars: string[]; results: string[] }): string {
  return [
    `Preparar a semana de ${o.weekStart} (segunda) a ${o.weekEnd} (domingo). Agora: ${nowBrt(o.now)} (Brasília).`,
    '',
    'Leia antes: `equipe/funcoes/coordenador.md`, `equipe/base.md`, `equipe/destinos.md`, `equipe/contratos.md` (seção 2) e `referencias/originais.md`.',
    o.radar.length ? `Radar recente: ${o.radar.map(p => '`' + p + '`').join(', ')}.` : 'Ainda não há rodada do Radar concluída: planeje com os objetivos e os materiais existentes, e diga isso no resumo.',
    o.calendars.length ? `Calendários anteriores (não repita pauta): ${o.calendars.map(p => '`' + p + '`').join(', ')}.` : 'Primeiro calendário da sala.',
    o.results.length ? `Resultados e análises: ${o.results.map(p => '`' + p + '`').join(', ')}.` : 'Ainda não há resultados registrados: trate tudo como hipótese.',
    o.note ? `Pedido do Chefe para esta semana: ${o.note}` : '',
    '',
    'Comece com duas ou três peças-base, adaptadas aos destinos adequados (versões próprias, não cópias), mais notas curtas do X só se houver notícia confirmada. Use projetos e vídeos reais do inventário; separe o que está pronto do que precisa ser gravado ou editado. Cada item com responsável `criador` e a skill da rede (rede-instagram, rede-threads, rede-tiktok, rede-linkedin, rede-x ou rede-pinterest).',
    '',
    `Grave em \`${o.outputPath}\` (JSON do contrato) e um \`calendario.md\` legível na mesma pasta.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Marca da rodada automática de ajuste: o revisor pediu, a criação refaz uma vez sozinha; depois disso a decisão é do Chefe. */
export const AUTO_REWORK_MARK = 'Ajuste pedido pelo revisor (rodada automática';
/** Marca da correção automática: a conferência da HQ não achou um arquivo exigido; quem produziu corrige uma vez sozinho. */
export const AUTO_FIX_MARK = 'Correção pedida pela conferência da HQ (rodada automática';
/** Já houve uma rodada automática (de revisão ou de conferência) nesta produção: a próxima decisão é do Chefe. */
export function hadAutoRound(prompt: string | null | undefined): boolean {
  return Boolean(prompt && (prompt.includes(AUTO_REWORK_MARK) || prompt.includes(AUTO_FIX_MARK)));
}

export function piecePrompt(o: { item: ContentItem; folder: string; profileName: string | null; note?: string | null; noteFrom?: 'chefe' | 'revisor' | 'conferencia'; academy?: boolean; steps?: string | null }): string {
  const i = o.item; const def = i.slot ? slotDef(i.slot) : null;
  return [
    `Produzir a peça "${i.title}".`,
    '',
    'Ficha:',
    `- Responsável: Criação de conteúdo (você)`,
    `- Conta: ${def ? `${def.label} (\`${i.slot}\`)` : 'não definida'}${o.profileName ? ` · perfil ${o.profileName}` : ''}`,
    `- Data sugerida: ${i.date ?? 'sem data'}`,
    `- Formato: ${i.format || 'a definir pela especialidade'}`,
    `- Objetivo: ${i.objective || 'ver equipe/destinos.md'}`,
    `- Skill: ${i.skill ?? 'nenhuma'}`,
    `- Briefing: ${i.brief || '(sem briefing)'}`,
    `- Fontes: ${i.sources.length ? i.sources.join(' ; ') : 'nenhuma ainda'}`,
    `- Arquivos: ${i.files.length ? i.files.join(' ; ') : 'nenhum indicado'}`,
    `- Material: ${i.material}`,
    `- Critério de revisão: ${i.reviewCriteria || 'clareza, fatos com fonte, identidade da marca e limites da rede'}`,
    `- Id da peça na HQ: ${i.id}`,
    o.steps ? `- ${o.steps}` : '',
    o.note ? (o.noteFrom === 'revisor' ? `- ${AUTO_REWORK_MARK}; depois desta, a decisão é do Chefe): ${o.note}\n  Leia também \`revisao.md\` na pasta da peça. Corrija só o que o revisor apontou e mantenha o resto.`
      : o.noteFrom === 'conferencia' ? `- ${AUTO_FIX_MARK}; depois desta, a decisão é do Chefe): ${o.note}\n  Citar o nome de um arquivo na resposta não é entrega: o arquivo precisa existir na pasta da peça. Entregue o que falta e mantenha o resto.`
      : `- Observação do Chefe: ${o.note}`) : '',
    '',
    'Leia `equipe/funcoes/criador.md` (ou `equipe/funcoes/video.md`, se você é da edição de vídeo), `equipe/base.md`, `equipe/destinos.md` e `equipe/contratos.md` (seção 3).',
    `Grave tudo na pasta \`${o.folder}\`: o arquivo principal \`peca.md\`, os arquivos de apoio da rede e \`entrega.json\`.`,
    def?.network === 'pinterest' ? 'Pinterest: escreva `pin.html` (1000×1500) com as capturas reais; a HQ gera o `pin.png`.' : '',
    isCarousel(i.format, def?.network ?? null) ? CAROUSEL_RULE : '',
    isVideo(i.format, def?.network ?? null) ? VIDEO_RULE : '',
    isVideo(i.format, def?.network ?? null) && o.academy ? ACADEMY_RULE : '',
    i.hypothesis ? `- Hipótese editorial: ${i.hypothesis}` : '- Escreva a hipótese editorial principal da peça no peca.md (o que esperamos que aconteça e por quê).',
    i.slot === 'instagram-aurora' ? 'Aurora: traduza a ideia em demonstração do trabalho do Chefe (antes/depois real, decisão de interface, bastidor, problema resolvido). Nada de cliente, depoimento, número ou resultado inventado; não é a mesma peça do Tuco com outro logo.' : '',
    i.slot === 'threads' ? 'Threads da Aurora: texto natural que faça sentido sozinho (comentário sobre a referência, bastidor, observação ou pergunta específica), sem copiar a legenda do Instagram; até 500 caracteres.' : '',
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Academia de Vídeo (07/11): o que a equipe aprendeu volta em todo vídeo, pelo índice curto e só a ficha que for usar. */
const ACADEMY_RULE = 'Academia de Vídeo: antes de escrever as cenas, leia `academia/INDICE.md` e abra só a ficha da técnica que for aplicar (`academia/tecnicas/<slug>.md`). Diga no peca.md qual técnica usou e onde. Se o briefing citar um `direcao.md` (roteiro e storyboard do Diretor de Vídeo), siga o storyboard e grave o seu `storyboard.md` final na pasta da peça (cena, tempo, o que aparece, movimento, texto, som).';

/** Formato de vídeo (Reels/TikTok): a HQ renderiza a partir do video.json. */
export function isVideo(format: string | null | undefined, network: string | null): boolean {
  return /reel|v[íi]deo|short|tiktok/i.test(format ?? '') || (network === 'tiktok' && !isCarousel(format, network));
}

const VIDEO_RULE = [
  'Vídeo: escreva `video.json` (contrato em `equipe/contratos.md`, seção 3c). A HQ renderiza o MP4 1080×1920 com a composição CenasReel, gera `capa.png` e um quadro de cada cena em `quadros/`; você não renderiza nem roda nada.',
  'Planeje a animação junto com o roteiro: cada cena diz o que aparece (mostra), o que acontece visualmente (acao), o que fica claro (informacao) e como a próxima continua (transicao). Cada conceito central ganha uma ação, transformação ou demonstração (elementos entrando e se conectando, interface com cursor e resultado, código que roda e mostra a saída verdadeira, diagrama com o pedido indo e voltando, revelação). Imagem parada com zoom e legenda não é Reel animado; efeito aleatório também não. Sem corte forçado a cada 2 s: o movimento acompanha a explicação ou a piada.',
  'Texto na tela grande e com tempo de leitura; margem livre embaixo (~250 px) e em cima (~180 px). Fato técnico só com fonte primária (documentação, anúncio oficial), citada no peca.md. Áudio: trilha e efeitos gerados pela HQ; marque "provisorio": true se for rascunho (vira pendência).',
  'O `peca.md` leva a legenda final, a hipótese, a referência (de onde veio a ideia e o que foi adaptado) e as fontes; `entrega.json` lista `video.json`, `video.mp4` e `capa.png` em "files".',
].join('\n');

/** Formato de carrossel (Instagram, LinkedIn em documento): a HQ desenha as imagens a partir do carrossel.json. */
export function isCarousel(format: string | null | undefined, network: string | null): boolean {
  return /carross|carousel|slides/i.test(format ?? '') && network !== 'pinterest';
}

const CAROUSEL_RULE = [
  'Carrossel: escreva `carrossel.json` (contrato em `equipe/contratos.md`, seção 3b). A HQ desenha as imagens 1080×1350 na identidade da marca e grava `slides/01.png`, `slides/02.png`…; você não desenha nem roda nada.',
  'Texto curto por slide (título de até ~8 palavras; texto de até ~3 linhas): o que não couber encolhe a letra e, no limite, volta como erro para você encurtar.',
  'O `peca.md` leva a legenda do post (sem travessão), as fontes e o roteiro dos slides; `entrega.json` lista `carrossel.json` em "files".',
].join('\n');

export function reviewPrompt(o: { item: ContentItem; folder: string; checks: string }): string {
  const i = o.item; const def = i.slot ? slotDef(i.slot) : null;
  return [
    `Revisar a peça "${i.title}" (${def ? def.label : 'conta não definida'}).`,
    '',
    'Leia `equipe/funcoes/revisor.md` (Revisar uma peça), `equipe/base.md`, `equipe/destinos.md` e a skill da rede.',
    `Pasta da peça: \`${o.folder}\` (\`peca.md\`, \`entrega.json\` e arquivos de apoio).`,
    isCarousel(i.format, def?.network ?? null) ? 'Carrossel: abra e olhe cada imagem em `slides/` (01.png, 02.png…) com a ferramenta Read: texto legível, nada cortado, ordem que faz sentido, fato com fonte. A imagem é o que vai ao ar; o `carrossel.json` é só a fonte dela.' : '',
    isVideo(i.format, def?.network ?? null) ? 'Vídeo: abra `capa.png` e cada quadro em `quadros/` com a ferramenta Read e leia `video-conferencia.json` (movimento medido por cena). Critérios de dinamismo: cada cena do `video.json` mostra de fato a ação planejada; cada conceito central tem ação, transformação ou demonstração; nenhuma cena é só imagem parada com zoom; o movimento acompanha a explicação ou a piada (sem efeito aleatório); texto legível com tempo de leitura e fora das margens da interface; código na tela produz a saída mostrada; afirmação técnica com fonte primária. Cena parada que não é o fechamento = ajustar, dizendo qual e o que deve se mover. Se houver `audio-referencia.json` (o Chefe pediu o áudio de outro vídeo), confira pelos tempos da transcrição desse áudio (nas evidências citadas no briefing) que cada frase entra junto da cena que ela comenta; você não ouve o áudio: diga isso e compare só os tempos.' : '',
    `Critério de revisão da ficha: ${i.reviewCriteria || 'clareza, fatos com fonte, identidade da marca e limites da rede'}.`,
    `Verificações automáticas da HQ: ${o.checks}`,
    '',
    `Grave \`${o.folder}\\revisao.json\` (contrato, seção 4) e um \`revisao.md\` curto. Uma passada: aprovar ou dizer exatamente o que ajustar.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

const NET_HINTS: Record<string, string> = {
  instagram: 'Instagram na web: botão "Criar"/"Nova publicação" na navegação; confira que o upload de imagem/carrossel/vídeo aparece nesta conta antes de contar com ele.',
  threads: 'Threads na web: campo "O que há de novo?"/"Start a thread" na página inicial; texto até 500 caracteres.',
  tiktok: 'TikTok na web: https://www.tiktok.com/upload (vídeo). Sem vídeo renderizado, só chegue até onde o arquivo existir e diga o que falta.',
  linkedin: 'LinkedIn: publique no PERFIL PESSOAL cadastrado (não numa página), pelo "Começar publicação"/"Start a post" do feed; confira no editor que o autor é o perfil.',
  x: 'X: https://x.com/compose/post; texto em inglês exatamente como na entrega; a fonte da notícia fica no texto.',
  pinterest: 'Pinterest: https://www.pinterest.com/pin-builder/; anexe pin.png, preencha título, descrição e o link de destino da entrega e escolha a pasta (board) indicada.',
};

export function browserPreparePrompt(o: { item: ContentItem; network: string; files: string[]; text: string; title: string | null; destinationUrl: string | null; board: string | null }): string {
  const i = o.item; const def = i.slot ? slotDef(i.slot) : null;
  return [
    `Preparar no navegador, ATÉ A PRÉVIA, a peça "${i.title}" (${def?.label ?? 'sem conta'}). Não clique no botão final de publicar.`,
    '',
    `Use as ferramentas do navegador da HQ: abrir_conta(conta "${i.slot}", etapa "preparar") → abra o editor da rede → preencher com o texto exato abaixo → anexar os arquivos → ler_pagina para conferir a prévia → capturar_tela (nome "previa").`,
    NET_HINTS[o.network] ?? '',
    `Texto exato:\n${o.text}`,
    o.title ? `Título: ${o.title}` : '',
    o.destinationUrl ? `Link de destino: ${o.destinationUrl}` : '',
    o.board ? `Pasta: ${o.board}` : '',
    o.files.length ? `Arquivos: ${o.files.join(' ; ')}` : 'Sem arquivos.',
    '',
    'Se a prévia ficar correta, registrar_capacidade(capacidade "preparar", estado "testada", detalhe com o que foi visto). Se o site não oferecer o formato nesta conta (ex.: upload indisponível), registrar_capacidade com "indisponivel" e o motivo exato. Depois feche a janela de edição sem publicar (descartar o rascunho, se o site perguntar) e responda o que viu, com o caminho da captura.',
    RULES,
  ].filter(Boolean).join('\n');
}

export function browserPublishPrompt(o: { item: ContentItem; network: string; files: string[]; text: string; title: string | null; destinationUrl: string | null; board: string | null; when: string | null }): string {
  const i = o.item; const def = i.slot ? slotDef(i.slot) : null;
  return [
    `Publicar pelo navegador a peça aprovada "${i.title}" (${def?.label ?? 'sem conta'}). Id da peça: ${i.id}.`,
    '',
    `1. abrir_conta(conta "${i.slot}", etapa "publicar"): a HQ confere a identidade. Se pedir login do Chefe, pare e diga.`,
    '2. Abra o editor, preencha o texto exato e anexe os arquivos; confira a prévia (ler_pagina e capturar_tela "previa").',
    o.when ? `3. Horário pedido: ${o.when} (Brasília). Se o site oferecer agendamento nativo nesta conta e o horário estiver a mais de 30 min, agende (publicar com modo "agendar" e quando), depois abra a lista de agendados e verificar_publicacao(modo "agendar"). Se não oferecer, registrar_capacidade(agendar, indisponivel) e publique agora.` : '3. Publique agora.',
    '4. Botão final SÓ pela ferramenta publicar (itemId e alvo). Nunca clique duas vezes. Se ela disser "resultado a verificar", não tente de novo: abra o perfil, procure o post e use verificar_publicacao (url) ou nao_encontrado com captura.',
    '5. Depois do clique confirmado: abra o perfil, pegue o link do post e verificar_publicacao(itemId, url).',
    NET_HINTS[o.network] ?? '',
    `Texto exato:\n${o.text}`,
    o.title ? `Título: ${o.title}` : '',
    o.destinationUrl ? `Link de destino: ${o.destinationUrl}` : '',
    o.board ? `Pasta: ${o.board}` : '',
    o.files.length ? `Arquivos: ${o.files.join(' ; ')}` : 'Sem arquivos.',
    RULES,
  ].filter(Boolean).join('\n');
}

export function collectPrompt(o: { slots: { slot: string; label: string }[]; now: number }): string {
  return [
    `Ler resultados nas contas pelo navegador da HQ. Agora: ${nowBrt(o.now)} (Brasília).`,
    '',
    `Contas verificadas: ${o.slots.map(s => `${s.label} (${s.slot})`).join('; ')}.`,
    'Para cada conta: abrir_conta(etapa "ler_metricas") → abra a área de análise/insights que o site oferecer nesta conta (ou as publicações recentes) → ler_pagina → capturar_tela → registrar_resultado para cada número visível, com o nome exato da métrica, o período mostrado e o denominador quando houver. Número que não aparece = valor null com a observação "não disponível no site"; nunca zero.',
    'Se a conta não tiver painel de métricas no site, registrar_capacidade(ler_metricas, indisponivel, motivo exato). Uma conta com problema não impede as outras.',
    RULES,
  ].join('\n');
}

export function analysisPrompt(o: { outputPath: string; now: number; weekStart: string; resultsCsv: string; items: string[] }): string {
  return [
    `Análise semanal de resultados (semana de ${o.weekStart}). Agora: ${nowBrt(o.now)} (Brasília).`,
    '',
    'Leia `equipe/funcoes/revisor.md` (Ler resultados), `equipe/destinos.md` e `referencias/espelho/milweb-video-studio/performance.md`.',
    `Resultados registrados na HQ (exportados agora): \`${o.resultsCsv}\`.`,
    o.items.length ? `Peças publicadas no período: ${o.items.join(' ; ')}.` : 'Nenhuma peça registrada como publicada no período.',
    '',
    'Entregue: o que foi observado, o que parece promissor, o que ajustar e um teste pequeno com critério definido antes. Métrica com nome exato, período e denominador; dado ausente é "não coletado". Sem causa atribuída a poucos dados.',
    `Grave em \`${o.outputPath}\` (contrato, seção 5) e um \`analise.md\` legível ao lado.`,
    RULES,
  ].join('\n');
}

export function transcriptionPrompt(o: { outputPath: string; imagePath: string; slot: string | null }): string {
  return [
    'Transcrever uma captura de métricas enviada pelo Chefe.',
    `Imagem: \`${o.imagePath}\`${o.slot ? ` (conta ${o.slot})` : ''}.`,
    'Leia `equipe/funcoes/revisor.md` (Transcrever captura). Só o que estiver legível, com o nome exato da métrica.',
    `Grave em \`${o.outputPath}\` (contrato, seção 6).`,
    RULES,
  ].join('\n');
}

/** Link a mais no mesmo pedido (áudio, estilo, outra referência), já inspecionado pela HQ. */
export interface VideoOther { n: number; url: string; role: 'audio' | 'estilo' | 'referencia'; note: string | null; level?: string; summary?: string | null; evidence?: string | null; error: string | null; sheets?: number; audioFile?: string | null }
const ROLE_PT: Record<VideoOther['role'], string> = { audio: 'áudio', estilo: 'estilo do vídeo', referencia: 'outra referência' };
const otherLine = (x: VideoOther) => `- Vídeo ${x.n} (${ROLE_PT[x.role]}): ${x.url}${x.note ? ` · o Chefe escreveu: "${x.note}"` : ''}${x.error ? ` · NÃO abriu: ${x.error}` : ''}`;

/** O que a HQ entrega ao analista de uma referência de vídeo (quadros anexados, Watch, evidências). */
export interface VideoSeen {
  sheets: number; hasPage: boolean;
  /** Skill Watch rodada pela HQ: quadros anexados (wNN-MMmSSs.jpg), relatório e a transcrição segundo ela. */
  watch?: { frames: number; report: string | null; transcript: string | null; error: string | null } | null;
}

/** Bloco comum: o que foi anexado, a Watch, as evidências e os outros vídeos do pedido. */
function seenBlock(o: { dir: string; url: string | null; level: string; summary: string; seen: VideoSeen; others: VideoOther[]; director: boolean }): string[] {
  const w = o.seen.watch;
  return [
    o.director ? 'A skill video-analyze está ativa: escreva o relatório no formato dela (Format Breakdown, Topic & Angle, Hook Analysis, Storytelling Structure, CTA Analysis, Visual & Production Notes, Replication Playbook, Raw Intelligence), em português do Brasil. A HQ já fez o passo 2 dela (o pipeline): rodou a skill Watch sobre o vídeo. NÃO rode scripts nem comandos (cada comando pede autorização do Chefe): pule os passos 2, 5 e 6 da skill e use o material abaixo, que já está anexado ou na pasta.' : '',
    w && w.frames ? `Neste pedido estão anexadas como imagem: ${w.frames} quadro(s) escolhidos pela Watch por mudança de cena (wNN-MMmSSs.jpg: o nome traz o tempo no vídeo) e ${o.seen.sheets} folha(s) de quadros da HQ${o.others.length ? ' do vídeo 1 (folha-NN.png)' : ' (folha-NN.png)'}, um quadro a cada intervalo fixo com o tempo no canto${o.seen.hasPage ? ', mais a captura da página do post' : ''}. Relatório da Watch: \`${w.report}\` (quadros e ${w.transcript && !/^none/i.test(w.transcript) ? `transcrição: ${w.transcript}` : 'sem legenda nativa'}).`
      : `Neste pedido estão anexadas como imagem ${o.seen.sheets} folha(s) de quadros do vídeo${o.others.length ? ' 1 (o principal: folha-NN.png)' : ''} (um quadro a cada intervalo fixo, com a marcação de tempo no canto)${o.seen.hasPage ? ' e a captura da página do post' : ''}.${w?.error ? ` A skill Watch não assistiu: ${w.error}.` : ''}`,
    'Olhe cada imagem antes de escrever. Você viu quadros, não o vídeo em movimento: não afirme fluidez, velocidade de animação nem transição que os quadros não mostrem; descreva "entre 00:03 e 00:04 o elemento X muda para Y" em vez de inventar o movimento.',
    o.url ? `Link${o.others.length ? ' do vídeo 1 (base: o que adaptar)' : ''}: ${o.url}` : 'Vídeo anexado pelo Chefe (sem link).',
    `Nível da inspeção feita pela HQ: ${o.level}. ${o.summary}`,
    `Evidências medidas pela HQ (cortes, planos, volume, silêncios e a transcrição automática, com os tempos): \`${o.dir}\\evidencias.md\`. Use os tempos de lá; marque tempo só onde foi verificado.`,
    ...(o.others.length ? [
      '',
      `O pedido tem mais ${o.others.length} vídeo(s), cada um com um papel. As folhas deles vêm anexadas como vN-folha-NN.png (o de áudio, só a primeira):`,
      ...o.others.map(x => `${otherLine(x)}${x.level ? ` · inspeção: ${x.level}${x.summary ? `. ${x.summary}` : ''}` : ''}${x.evidence ? ` · evidências: \`${x.evidence}\`` : ''}${x.sheets ? ` · ${x.sheets} folha(s) anexada(s)` : ''}${x.audioFile ? ` · áudio extraído: \`${x.audioFile}\`` : ''}`),
      'Para cada um, diga o que ele dá ao vídeo: no de áudio, as falas com os tempos (da transcrição) e onde cada frase cabe; no de estilo, o que copiar do visual (tipografia, cor, câmera, ritmo, efeitos) e o que não; se algum não abriu, diga o que fica faltando. Confirme ou corrija o papel que o Chefe deu a cada link.',
    ] : []),
  ];
}

/** O olhar do Diretor: técnica por técnica, observado × inferido, e como fazer com o que a casa tem. */
const DIRECTOR_EYE = 'Como Diretor de Vídeo & Motion Design, vá além do relatório: examine animações (o que entra, sai, se transforma), transições, cortes (tempos medidos nas evidências) e ritmo (duração dos planos, cortes por minuto), tipografia (peso, tamanho, posição, como o texto entra e sai), composição e cor, e o som. Música e efeitos sonoros NÃO foram ouvidos (só volume, silêncios e a transcrição automática): diga isso e não descreva o que não ouviu. Para cada técnica, marque OBSERVADO (aparece nos quadros ou nas medidas, com o tempo) ou INFERIDO (hipótese sua sobre como foi feito). Diga como reproduzir com as ferramentas da casa, sem nada pago: Remotion (a composição CenasReel, que a HQ renderiza a partir do video.json, contrato 3c), FFmpeg, GSAP ou CSS (animação de interface). Se a técnica pede algo que a casa não tem, diga o que falta.';
const ACADEMY_READ = 'Academia de Vídeo: se existir `academia/INDICE.md`, compare com as técnicas que a equipe já estudou e use o mesmo slug quando for a mesma técnica.';

/** Análise de uma referência de vídeo enviada pelo Chefe. Os quadros vão ANEXADOS como imagem neste pedido. */
export function videoAnalysisPrompt(o: { now: number; outputPath: string; dir: string; url: string | null; level: string; summary: string; liked: string | null; instruction: string | null; target: string | null; sheets: number; hasPage: boolean; others?: VideoOther[]; watch?: VideoSeen['watch']; director?: boolean }): string {
  const others = o.others ?? []; const director = Boolean(o.director);
  return [
    `Analisar uma referência de vídeo enviada pelo Chefe${director ? ', como Diretor de Vídeo & Motion Design da sala' : ''}. Agora: ${nowBrt(o.now)} (Brasília).`,
    '',
    ...seenBlock({ dir: o.dir, url: o.url, level: o.level, summary: o.summary, seen: { sheets: o.sheets, hasPage: o.hasPage, watch: o.watch ?? null }, others, director }),
    o.liked ? `O que o Chefe gostou neste vídeo: ${o.liked}. Priorize isso.` : 'O Chefe não disse do que gostou: identifique os mecanismos mais relevantes (abertura, ritmo, animação, humor, transição, demonstração).',
    o.instruction ? `Pedido do Chefe: ${o.instruction}` : '',
    o.target ? `Destino: ${o.target}.` : 'Destino ainda não escolhido: recomende Tuco Dev ou Aurora.',
    '',
    director ? DIRECTOR_EYE : 'Escreva uma análise curta e concreta, que oriente a edição: ideia central, público aparente e promessa; abertura, progressão, virada e encerramento; enquadramento, duração dos planos, movimento e transições observados; como animação, camadas, demonstração e texto ajudam a explicar ou divertir; fala, música e efeitos conforme o acesso real (música e efeitos NÃO foram ouvidos: diga isso); o que vale adaptar, o que não combina com a marca e os materiais necessários.',
    'Separe observação da referência de hipótese criativa. Um vídeo que o Chefe mandou é uma referência: não chame de tendência nem de prova de crescimento.',
    'Feche com até duas abordagens de adaptação para a nossa marca, com a recomendada e o esforço. Tuco Dev: explicação tech acessível, personalidade e movimento que ajude a entender (elementos se transformando, diagrama animado, interface em ação, demonstração, revelação), nunca imagem com zoom e legenda. Aurora: ligada aos projetos e decisões reais do Chefe; demo, conceito e cliente real são coisas diferentes.',
    director ? ACADEMY_READ : '',
    director
      ? `Grave na pasta \`${o.dir}\`: (1) \`analise.md\`, o relatório no formato do Video Analyzer mais a seção "Direção de vídeo" (técnicas OBSERVADO × INFERIDO, com tempo e como fazer); (2) \`direcao.md\`, a versão recomendada como roteiro curto e storyboard (tabela: cena, tempo, o que aparece, movimento ou técnica, texto na tela, som), pronta para a edição (Teo no Tuco, Clara na Aurora); (3) \`${o.outputPath}\` (contrato em \`equipe/contratos.md\`, seção 1c, com "tecnicas" da seção 1e).`
      : `Grave \`${o.outputPath}\` (contrato em \`equipe/contratos.md\`, seção 1c) e um \`analise.md\` legível na mesma pasta.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Estudo para a Academia de Vídeo ("Equipe, estudem esse vídeo"): análise, lição, técnicas e exercícios. Não produz peça. */
export function studyPrompt(o: { now: number; outputPath: string; dir: string; url: string | null; level: string; summary: string; liked: string | null; instruction: string | null; sheets: number; hasPage: boolean; others?: VideoOther[]; watch?: VideoSeen['watch']; team: { name: string; role: string; profile: string | null }[] }): string {
  const others = o.others ?? [];
  return [
    `Estudo de vídeo para a Academia de Vídeo da empresa, como Diretor de Vídeo & Motion Design. Agora: ${nowBrt(o.now)} (Brasília).`,
    o.instruction ? `O Chefe escreveu: "${o.instruction}"` : 'O Chefe mandou este vídeo para a equipe estudar.',
    'Ele quer que a equipe aprenda a fazer vídeos deste nível. O seu trabalho aqui é estudar, ensinar e treinar a equipe; não é produzir uma peça para postar.',
    '',
    ...seenBlock({ dir: o.dir, url: o.url, level: o.level, summary: o.summary, seen: { sheets: o.sheets, hasPage: o.hasPage, watch: o.watch ?? null }, others, director: true }),
    o.liked ? `O que o Chefe destacou: ${o.liked}. Priorize isso.` : '',
    '',
    DIRECTOR_EYE,
    ACADEMY_READ,
    `Equipe que você treina: ${o.team.map(t => `${t.name} (${t.role}${t.profile ? `, ${t.profile}` : ''})`).join('; ')}.`,
    '',
    `Grave na pasta \`${o.dir}\`:`,
    '1. `analise.md`: o relatório no formato do Video Analyzer mais a seção "Direção de vídeo" (cada técnica OBSERVADO × INFERIDO, com o tempo).',
    '2. `licao.md`: a aula para a equipe. O que faz este vídeo funcionar; cada técnica com o passo a passo nas ferramentas da casa (Remotion/CenasReel pelo video.json, FFmpeg, GSAP ou CSS); o que dá para fazer já e o que depende de material ou ferramenta que a casa não tem (diga qual, sem propor serviço pago). Escreva para quem vai fazer: exemplos concretos, valores (durações, easing, tamanhos), nada genérico.',
    '3. Exercícios: de 2 a 5, um por pessoa envolvida, pequenos e práticos (um trecho de 5 a 12 s, não um Reel inteiro), cada um aplicando 1 ou 2 técnicas. Edição (papel "video", Teo no Tuco Dev e Clara na Aurora) entrega um video.json que a HQ renderiza; criação ("criador", Nina e Bia) entrega roteiro.md e storyboard.md de um Reel da equipe dela usando a técnica; revisão ("revisor", Otto) entrega checklist.md para conferir a técnica numa peça; pauta ("coordenador") só se fizer sentido. Diga a equipe (tuco-dev ou aurora) de cada exercício de edição ou criação.',
    `4. \`${o.outputPath}\` (contrato em \`equipe/contratos.md\`, seção 1e) e \`analise-video.json\` (seção 1c) na mesma pasta.`,
    'Não copie o vídeo de terceiros: os exercícios recriam a técnica com material e assunto nossos.',
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Pauta da aula (reunião da Academia): o Diretor apresenta, cada um diz como vai aplicar e a dúvida que tem. */
export function lessonAgenda(o: { title: string; director: string; lesson: string; summary: string; techniques: { name: string; evidence: string }[]; exercises: { who: string; title: string }[] }): string {
  return [
    `Aula da Academia de Vídeo: "${o.title}".`,
    `${o.director} (Diretor de Vídeo & Motion Design) apresenta a lição (\`${o.lesson}\`, no contexto da reunião): ${o.summary}`,
    `Técnicas: ${o.techniques.map(t => `${t.name} (${t.evidence})`).join('; ')}. O que é inferência do Diretor não foi verificado no vídeo: tratem como hipótese.`,
    'Cada participante responde em poucas linhas: o que entendeu, como vai aplicar no próprio trabalho (edição, roteiro, revisão ou pauta) e a dúvida que tem. O Diretor responde às dúvidas.',
    `Exercícios já definidos pelo Diretor (feitos depois da aula): ${o.exercises.map(e => `${e.who}: ${e.title}`).join('; ')}.`,
    'Uma rodada. A síntese entrega: cada técnica em uma linha, as dúvidas respondidas e o combinado para os exercícios. Ninguém produz peça nem publica nada nesta reunião.',
  ].join('\n');
}

/** Exercício da Academia para um funcionário. É treino: não vira peça, não vai para o Mural nem para publicação. */
export function exercisePrompt(o: { now: number; study: string; director: string; title: string; instructions: string; deliverable: string; dir: string; lesson: string | null; techniqueFiles: string[]; synthesis: string | null; video: boolean; brand: string | null }): string {
  return [
    `Exercício da Academia de Vídeo (estudo "${o.study}"), passado pelo Diretor de Vídeo ${o.director}. Agora: ${nowBrt(o.now)} (Brasília).`,
    '',
    `Leia antes: ${o.lesson ? `a lição \`${o.lesson}\`` : 'a lição do estudo'}${o.techniqueFiles.length ? `, as fichas ${o.techniqueFiles.map(f => '`' + f + '`').join(', ')}` : ''}${o.synthesis ? ` e a síntese da aula: \`${o.synthesis}\`` : ''}, e \`equipe/contratos.md\` (seção 1f).`,
    `Exercício: ${o.title}`,
    o.instructions,
    `Entrega: ${o.deliverable}`,
    `Pasta do exercício: \`${o.dir}\` (grave tudo aqui).`,
    o.video ? `Edição: escreva \`video.json\` nesta pasta (contrato em \`equipe/contratos.md\`, seção 3c; marca "${o.brand ?? 'tuco-dev'}"; poucas cenas, de 6 a 12 s no total; siga o número de cenas da lição) aplicando a técnica. A HQ renderiza \`exercicio.mp4\` com a CenasReel e guarda um quadro de cada cena para o Diretor corrigir; você não renderiza nem roda nada. Liste \`video.json\` em "arquivos".` : '',
    'Ao terminar, grave `resultado.json` (seção 1f): o que fez, os arquivos, o que aprendeu e as dúvidas que ficaram. Se algo da técnica não couber nas ferramentas da casa, faça a versão mais próxima e diga a diferença.',
    'É treino: não vira peça, não vai para o Mural nem para publicação.',
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Correção dos exercícios pelo Diretor: veredito por exercício, armadilhas novas e o resumo para a equipe. */
export function correctionPrompt(o: { now: number; study: string; outputPath: string; dir: string; lesson: string | null; exercises: { id: string; who: string; title: string; dir: string; status: string; result: string | null; files: string[]; error: string | null }[] }): string {
  return [
    `Corrigir os exercícios da Academia de Vídeo (estudo "${o.study}"), como Diretor de Vídeo & Motion Design. Agora: ${nowBrt(o.now)} (Brasília).`,
    o.lesson ? `Lição: \`${o.lesson}\`.` : '',
    'Exercícios (abra o resultado.json, os arquivos e, no de edição, o que a HQ tirou do vídeo renderizado, na pasta do exercício: `quadros/quadro-NN.png` = meio de cada cena, `quadros/fim-NN.png` = 90% da cena, logo antes do corte, `capa.png` e `video-conferencia.json` com o movimento medido por cena; os de edição vêm anexados):',
    ...o.exercises.map(e => `- ${e.id} · ${e.who} · ${e.title} · ${e.status}${e.error ? ` (${e.error})` : ''} · pasta \`${e.dir}\`${e.result ? ` · resultado: ${e.result.slice(0, 200)}` : ''}${e.files.length ? ` · arquivos: ${e.files.map(f => '`' + f + '`').join(', ')}` : ''}`),
    '',
    'Para cada exercício entregue: veredito "ok" (a técnica foi aplicada) ou "ajustar", com um comentário concreto (o que funcionou, o que corrigir e como, citando a técnica e o tempo ou a cena). Exercício que não foi entregue: "ajustar" com o motivo. Junte as armadilhas que apareceram por técnica (slug).',
    `Grave \`correcao.md\` (para a equipe, curto) e \`${o.outputPath}\` (contrato em \`equipe/contratos.md\`, seção 1g) na pasta \`${o.dir}\`.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Pauta da reunião vinculada à referência: papéis, o que cada um recebeu e o que a síntese precisa entregar. */
export function videoMeetingAgenda(o: { title: string; url: string | null; level: string; target: string | null; liked: string | null; mode: 'analise' | 'produzir' | 'estudo'; researcher: string; editorial: string; editor: string; others?: VideoOther[] }): string {
  const others = o.others ?? [];
  return [
    `Referência de vídeo do Chefe: ${o.title}${o.url ? ` (${o.url})` : ''}.`,
    `Objetivo: decidir como adaptar o mecanismo deste vídeo para ${o.target ?? 'o perfil mais adequado (Tuco Dev ou Aurora)'}, com material e identidade nossos.`,
    ...(others.length ? [`O pedido junta mais ${others.length} vídeo(s), e a versão precisa usar cada um no papel dado:`, ...others.map(otherLine)] : []),
    others.some(x => x.role === 'audio') ? 'Áudio: a cena segue o tempo da fala desse vídeo (a transcrição com os tempos está nas evidências dele). A HQ gera um vídeo com esse áudio no instante que a edição marcar; o video.mp4 fica sem ele.' : '',
    o.liked ? `O Chefe gostou de: ${o.liked}.` : '',
    `Papéis: ${o.researcher} apresenta a análise (foi quem olhou os quadros); ${o.editorial} propõe a adaptação editorial; ${o.editor} explica como executar no vídeo (cenas, animação, ritmo, som); o gerente consolida. ${o.researcher} viu as folhas de quadros e as evidências medidas (nível: ${o.level}); os demais receberam o relatório dele: falem com base no relatório, sem dizer que assistiram ao vídeo.`,
    'Uma proposta e uma revisão. A síntese entrega: até duas abordagens viáveis, a recomendada e por quê, o esforço de produção, e a recomendada já convertida em roteiro curto, sequência de cenas (o que aparece, o que acontece e o que fica claro em cada cena) e tarefas concretas. Pergunte ao Chefe só uma escolha essencial que o contexto não resolva.',
    o.mode === 'produzir' ? 'Modo: analisar e produzir. A direção recomendada segue para a produção sem nova aprovação.' : 'Modo: só análise. Entreguem a proposta; produzir depende do Chefe ("Produzir esta versão").',
    'Nada de publicar ou agendar. Material de terceiros só com permissão; recrie o efeito com material próprio.',
  ].filter(Boolean).join('\n');
}

/** Briefing da produção a partir da síntese da reunião. */
export function videoPieceBrief(o: { synthesis: string; title: string; url: string | null; analysisMd: string | null; evidence: string; liked: string | null; instruction: string | null; others?: VideoOther[]; direction?: string | null; analyst?: string | null }): string {
  const others = o.others ?? [];
  const audio = others.find(x => x.role === 'audio' && x.audioFile);
  return [
    `Versão própria inspirada na referência do Chefe "${o.title}"${o.url ? ` (${o.url})` : ''}. A origem fica registrada no peca.md; a imagem de terceiros não entra no nosso vídeo (recrie o efeito com material próprio).`,
    o.instruction ? `Pedido do Chefe: ${o.instruction}` : '',
    o.liked ? `O que o Chefe gostou na referência: ${o.liked}` : '',
    `Análise ${o.analyst ? `de ${o.analyst}` : 'do pesquisador'}: ${o.analysisMd ? `\`${o.analysisMd}\`` : 'ver a pasta da referência'}; evidências medidas: \`${o.evidence}\`.`,
    o.direction ? `Roteiro e storyboard do Diretor de Vídeo: \`${o.direction}\`. Siga o storyboard (cenas, tempos, técnica) e grave o seu \`storyboard.md\` final na pasta da peça.` : '',
    ...(others.length ? ['Outros vídeos do pedido:', ...others.map(x => `${otherLine(x)}${x.evidence ? ` · evidências: \`${x.evidence}\`` : ''}`)] : []),
    audio ? `Áudio pedido pelo Chefe (vídeo ${audio.n}): \`${audio.audioFile}\`. Monte as cenas no tempo da fala (cada frase aparece quando é dita; os tempos estão na transcrição das evidências dele). No video.json use "trilha": "nenhuma" ou "gerada" (sem esse áudio). Grave também \`audio-referencia.json\` na pasta da peça (contrato em \`equipe/contratos.md\`, seção 3d): {"arquivo": "<o caminho acima>", "entraEm": <segundo do nosso vídeo em que o áudio começa>, "inicio": <segundo do áudio onde o trecho começa>, "fim": <onde termina ou null>, "volume": 1}. A HQ gera \`video-com-audio.mp4\` para o Chefe ouvir e decidir; o video.mp4 fica sem esse áudio.` : '',
    others.some(x => x.role === 'audio' && !x.audioFile) ? 'O áudio pedido pelo Chefe não foi obtido pela HQ: monte as cenas pela transcrição se houver e diga no peca.md que a versão com o áudio ficou pendente.' : '',
    '',
    'Direção decidida na reunião (síntese do gerente):',
    o.synthesis.slice(0, 6000),
  ].filter(l => l !== '').join('\n');
}
