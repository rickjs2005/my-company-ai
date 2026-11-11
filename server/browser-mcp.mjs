// Ferramentas de navegador para os funcionários da HQ (servidor MCP por stdio, lançado pelo Claude Code do funcionário).
// Não abre navegador nenhum: cada chamada vai para o navegador da HQ (único dono das janelas, contas e travas) por HTTP
// local com o token desta conversa. JavaScript puro: roda com o node, sem tsx.
import readline from 'node:readline';

const URL_BASE = process.env.HQ_BROWSER_URL;
const TOKEN = process.env.HQ_BROWSER_TOKEN;
const out = m => process.stdout.write(JSON.stringify(m) + '\n');

const conta = { type: 'string', description: 'Id da conta na HQ: instagram-aurora, instagram-tuco, threads, tiktok, linkedin, x ou pinterest.' };
const etapa = { type: 'string', enum: ['pesquisar', 'ler_metricas', 'preparar', 'publicar', 'verificar'], description: 'Etapa do trabalho (aparece na atividade do funcionário).' };
const alvo = {
  type: 'object', description: 'Elemento da página. Prefira papel + nome (como aparecem em ler_pagina).',
  properties: { papel: { type: 'string', description: 'button, link, textbox, combobox, checkbox, tab, menuitem...' }, nome: { type: 'string' }, rotulo: { type: 'string' }, placeholder: { type: 'string' }, texto: { type: 'string' }, testid: { type: 'string' }, exato: { type: 'boolean' }, indice: { type: 'number' } },
};
const TOOLS = [
  { name: 'contas', description: 'Lista as sete contas cadastradas na HQ: cadastro, perfil editorial, modo, estado do login no navegador e capacidades testadas.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pesquisar', description: 'PESQUISA DE TENDÊNCIAS (só leitura, sem conta): abre a URL do X, Reddit, Instagram ou Threads numa aba própria da HQ no Edge do Chefe, com os logins dele, e devolve a página lida. Sem url, relê a página atual. "rolar" (0 a 10) desce a página antes de ler, para carregar mais publicações. Exemplos: https://x.com/search?q=vibe%20coding&f=top · https://x.com/search?q=vibe%20coding&f=live · https://www.reddit.com/r/ProgrammerHumor/top/?t=day · https://www.reddit.com/r/webdev/hot/ · https://www.instagram.com/explore/search/keyword/?q=programming · https://www.instagram.com/<perfil>/ · https://www.threads.com/search?q=webdev. Não curte, não segue, não comenta.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, rolar: { type: 'number' }, limite: { type: 'number' } } } },
  { name: 'pesquisar_clicar', description: 'Na aba de pesquisa: clica num link ou botão de leitura (abrir publicação, "mostrar mais", trocar de aba da página) e devolve a página lida. Curtir, seguir, repostar, responder, salvar, compartilhar e votar são recusados.', inputSchema: { type: 'object', properties: { alvo, limite: { type: 'number' } }, required: ['alvo'] } },
  { name: 'pesquisar_capturar', description: 'Na aba de pesquisa: salva uma captura em radar/capturas/ (a tela, ou só um elemento com "alvo", por exemplo a publicação inteira). Serve de referência para a equipe; nunca republique a captura de outra pessoa.', inputSchema: { type: 'object', properties: { nome: { type: 'string' }, alvo } } },
  { name: 'abrir_conta', description: 'Abre uma conta da Aurora/Tuco no navegador da HQ para PREPARAR, PUBLICAR ou LER MÉTRICAS, conferindo o @ na interface do site. Para só ler a rede (tendências), use pesquisar.', inputSchema: { type: 'object', properties: { conta, etapa, url: { type: 'string' } }, required: ['conta', 'etapa'] } },
  { name: 'conferir_identidade', description: 'Lê de novo a conta logada na interface do site e compara com o cadastro.', inputSchema: { type: 'object', properties: { conta } } },
  { name: 'navegar', description: 'Vai para uma URL na conta aberta.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, conta, etapa }, required: ['url'] } },
  { name: 'ler_pagina', description: 'Lê a página atual como árvore de acessibilidade (papéis, nomes, textos, links). Use antes de agir e depois de cada mudança.', inputSchema: { type: 'object', properties: { limite: { type: 'number' }, conta, etapa } } },
  { name: 'clicar', description: 'Clica num elemento visível (não serve para o botão final de publicar/agendar: use publicar).', inputSchema: { type: 'object', properties: { alvo, conta, etapa }, required: ['alvo'] } },
  { name: 'preencher', description: 'Preenche um campo de texto ou editor com o texto exato.', inputSchema: { type: 'object', properties: { alvo, texto_campo: { type: 'string' }, conta, etapa }, required: ['alvo', 'texto_campo'] } },
  { name: 'teclar', description: 'Pressiona uma tecla (Enter, Escape, Tab...).', inputSchema: { type: 'object', properties: { tecla: { type: 'string' }, conta, etapa }, required: ['tecla'] } },
  { name: 'anexar', description: 'Anexa arquivos da pasta de conteúdo (campo de arquivo da página ou botão que abre a escolha de arquivo).', inputSchema: { type: 'object', properties: { arquivos: { type: 'array', items: { type: 'string' } }, alvo, conta, etapa }, required: ['arquivos'] } },
  { name: 'esperar_texto', description: 'Espera um texto aparecer na página (até 60 s).', inputSchema: { type: 'object', properties: { texto: { type: 'string' }, segundos: { type: 'number' }, conta, etapa }, required: ['texto'] } },
  { name: 'capturar_tela', description: 'Salva uma captura da janela na pasta de conteúdo (evidência). Não capture telas com senha ou código de verificação.', inputSchema: { type: 'object', properties: { nome: { type: 'string' }, conta, etapa } } },
  { name: 'publicar', description: 'Botão final de publicar ou agendar. Só funciona com a peça aprovada (lote, conta e período), a identidade conferida e o texto da peça no editor. A HQ grava a intenção antes do clique.', inputSchema: { type: 'object', properties: { itemId: { type: 'string' }, alvo, modo: { type: 'string', enum: ['publicar', 'agendar'] }, quando: { type: 'string', description: 'Data e hora do agendamento nativo (America/Sao_Paulo), quando modo = agendar.' }, conta }, required: ['itemId', 'alvo'] } },
  { name: 'verificar_publicacao', description: 'Confere o post na conta logada (URL do post) e registra a publicação; ou registra que o post NÃO apareceu (nao_encontrado: true, com captura do perfil).', inputSchema: { type: 'object', properties: { itemId: { type: 'string' }, url: { type: 'string' }, modo: { type: 'string', enum: ['publicar', 'agendar'] }, nao_encontrado: { type: 'boolean' }, evidencia: { type: 'string' }, conta }, required: ['itemId'] } },
  { name: 'registrar_resultado', description: 'Registra um número lido na interface da rede (nome exato da métrica, período, denominador). Valor ausente = null (não coletado), nunca zero.', inputSchema: { type: 'object', properties: { conta, metrica: { type: 'string' }, valor: { type: ['number', 'null'] }, unidade: { type: 'string' }, periodo_inicio: { type: 'string' }, periodo_fim: { type: 'string' }, denominador: { type: 'string' }, url: { type: 'string' }, itemId: { type: 'string' }, evidencia: { type: 'string' }, observacao: { type: 'string' } }, required: ['conta', 'metrica'] } },
  { name: 'registrar_capacidade', description: 'Marca uma capacidade da conta: "indisponivel" com o motivo (ex.: o site não oferece agendamento nesta conta) ou "testada" para pesquisar, preparar e ler_metricas.', inputSchema: { type: 'object', properties: { conta, capacidade: { type: 'string', enum: ['pesquisar', 'ler_metricas', 'preparar', 'publicar', 'agendar'] }, estado: { type: 'string', enum: ['testada', 'indisponivel'] }, detalhe: { type: 'string' } }, required: ['conta', 'capacidade', 'estado', 'detalhe'] } },
  { name: 'fechar', description: 'Fecha a aba de pesquisa e a janela da conta abertas por você (os logins do Chefe continuam).', inputSchema: { type: 'object', properties: {} } },
];

async function call(name, args) {
  if (!URL_BASE || !TOKEN) return { text: 'Navegador da HQ indisponível nesta conversa (sem endereço ou token).', isError: true };
  try {
    const res = await fetch(`${URL_BASE}/browser/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ tool: name, args: args ?? {} }), signal: AbortSignal.timeout(20 * 60_000) });
    const j = await res.json().catch(() => ({ ok: false, text: `resposta inválida (HTTP ${res.status})` }));
    return { text: String(j.text ?? ''), isError: !j.ok };
  } catch (err) { return { text: `Navegador da HQ não respondeu: ${err.message}`, isError: true }; }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hq-navegador', version: '1.0.0' } } });
  if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const r = await call(m.params?.name, m.params?.arguments);
    return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } });
  }
  if (m.id !== undefined && m.method) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `método desconhecido: ${m.method}` } });
});
