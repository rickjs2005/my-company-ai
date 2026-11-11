# MilWeb HQ

Empresa virtual em pixel art que dirige o **Claude Code real** instalado neste computador. Cada funcionário na tela é uma identidade persistente da equipe; a conversa ativa dele é uma sessão de verdade do `claude.exe` (modo `-p` com `stream-json`), rodando numa pasta de projeto local. Nada é simulado: fases, permissões, perguntas, resultados, arquivos tocados e o explorador de arquivos vêm do processo observado e do disco real.

> **Versão pública.** As marcas **Aurora** e **Tuco Dev**, as contas `@auroraexemplo` e `@tucoexemplo` e o endereço `aurora.example` são exemplos fictícios. Para usar com as suas marcas, edite `packages/protocol/src/teams.ts` (nomes e canais das equipes) e os textos em `content-kit/`. Nos textos da HQ, o dono da empresa aparece como "Chefe": é você.

## Instalação rápida

Pelo Claude Code, com a skill deste repositório:

1. Copie a pasta `skills/milweb-hq` para `~/.claude/skills/`.
2. No Claude Code, peça "instale a MilWeb HQ" ou use `/milweb-hq`.

Na mão: clone o repositório, rode `pnpm install` e `pnpm build`, e abra com `start-hq.cmd` (Windows).

Dependências opcionais que **não** vêm neste repositório: a skill de vídeo `milweb-video-studio` (a HQ mostra "não instalada" e segue sem ela) e o Codex CLI para o ChatGPT nas reuniões.

Licença: MIT (arquivo `LICENSE`). As fontes em `server/assets/carrossel/fonts` seguem a licença OFL que acompanha cada uma.


Você (o "Chefe" nos textos da HQ) tem um avatar na cena: anda pelo escritório, entra nas salas e interage com funcionários, mesas, armários e murais. Na **sala de Reuniões** (v3) você senta com o **Claude** (via Claude Code) e o **ChatGPT** (via Codex) para discutir uma pauta, anotar decisões, gerar a ata e transformar ações em tarefas reais da fila.

## Requisitos

- Windows 11, Node.js 24, pnpm 10.
- Claude Code instalado e logado (`claude auth status`). Testado com a versão **2.1.314** e, na validação da v3, com a **2.1.316** nativa em `~/.local/bin/claude.exe`.
- Sem `ANTHROPIC_API_KEY` no ambiente dos processos da HQ: o serviço remove a variável antes de iniciar o Claude Code, para a cobrança continuar na assinatura (claude.ai) e nunca cair na API.
- Opcional, para o ChatGPT na sala de reunião: **Codex CLI** (`npm i -g @openai/codex`) logado na conta ChatGPT (`codex login` ou o botão "Entrar com ChatGPT" em Ajustes). Sem ele, o cartão do ChatGPT mostra o motivo e a reunião segue só com o Claude.

## Como abrir

1. Dê dois cliques em `start-hq.cmd`. Na primeira vez ele instala as dependências e compila a interface.
2. O lançador (`server/launch.mjs`) sobe o serviço **em segundo plano, sem janela**, espera ele responder em `http://127.0.0.1:4777` e abre o navegador com o token na URL (`#token=…`; o token sai da barra de endereço assim que a página carrega). A janela do atalho fecha sozinha e o serviço continua: fechar o navegador ou essa janela não para nada.
3. Se a HQ **já estiver aberta**, o atalho não sobe um segundo serviço: só abre o navegador nela. Se a porta estiver ocupada por **outro programa**, o atalho mostra o motivo e para, sem encerrar processo nenhum; use outra porta com `set MILWEB_HQ_PORT=4790` antes de abrir.
4. **Encerrar**: Ajustes → Conexões → **Encerrar HQ** (pede confirmação). Os processos fecham de forma ordenada, as conversas ficam **pausadas** e são retomadas depois (o Claude Code reabre o histórico com `--resume`). Uma reunião com turno em andamento fica **pausada** com o turno marcado como perdido; nada é reenviado sozinho.
5. **Iniciar com o Windows** (Ajustes → Conexões): cria a tarefa agendada "MilWeb HQ" **no seu usuário**, no logon, sem administrador, chamando o mesmo lançador. Ela roda na sua sessão porque precisa dos logins do Claude Code e do Codex e das pastas dos projetos; um serviço de sistema não teria isso. Desmarcar remove a tarefa.
6. Diagnóstico: `start-hq.cmd --janela` roda o serviço numa janela, como antes (fechar a janela encerra a HQ). A saída do serviço em segundo plano vai para `logs/service-console.log`, além do `logs/server.log` de sempre ("Abrir logs" no cartão do serviço).

Se o serviço cair com o navegador aberto, a cena fica esmaecida mostrando o **último estado conhecido** (com a hora do último retrato) e a página reconecta sozinha quando o serviço voltar, sem duplicar funcionários, tarefas nem falas de reunião.

Na primeira abertura depois da v2 o banco é migrado para a versão 3 (backup `backups/hq-v2-<data>.sqlite` antes) e a sala de Reuniões entra na planta. A v4 migra para a versão 4 do mesmo jeito (backup `hq-v3-<data>.sqlite`).

## Trabalho do dia a dia (v4)

**Dar uma tarefa** — a faixa "O que vamos fazer?" fica embaixo, em qualquer sala. Escreva o pedido (o rascunho sobrevive à navegação), escolha **Projeto**, **Funcionário** (ou aceite a *Sugestão*, ou "+ Contratar funcionário…" sem perder o texto) e **Skill** ("Automática" deixa o funcionário decidir; a busca acha pelo nome). **Executar tarefa** (`Ctrl+Enter`) começa na hora ou entra na fila, e o cartão mostra a posição e o motivo. **Planejar antes** pede só o plano, sem alterar arquivos. **Opções** muda modelo, esforço e permissão só desta tarefa, e o que for escolhido fica valendo naquela conversa até mudar de novo. Se faltar algo, a linha de baixo diz o quê ("Falta: o projeto · o funcionário"). Clique duplo ou reconexão não cria tarefa repetida. `N` fora de campos de texto (ou "Nova tarefa" no Ctrl+K) leva o foco para o pedido. Na sala Social Media o campo se chama "O que vamos criar?" e mostra só o pedido, o funcionário, o perfil, **Opções** e **Executar**; projeto, skill, referências, destino, modelo, esforço, Ultracode, permissões e "Planejar antes" ficam dentro de Opções. O rascunho inteiro (texto, funcionário, projeto, opções) sobrevive a recarregar a página.

**Primeiro uso** — um guia de três passos (conectar uma IA, cadastrar projeto, contratar o primeiro funcionário), lido do estado real.

**Contratar** — nome, função, sala e provedor (Claude ou OpenAI). Modelo e esforço podem herdar o padrão. Há modelos de cargo editáveis (desenvolvedor, social media, designer, pesquisador, revisor) e a importação de **agentes nativos** do Claude Code (`~/.claude/agents`, `.claude/agents` do projeto e plugins): as ferramentas da definição são aplicadas com `--tools` e os campos que a HQ não consegue aplicar aparecem listados no perfil. Contratar não inicia nenhum processo.

**Skills** — a área Skills lista as skills reais desta máquina (pessoais, de projeto e de plugins habilitados), com busca, favoritas e filtros por origem, provedor e disponibilidade. Cada uma mostra descrição, quando usar, o que espera receber e um exemplo de pedido. Origem e caminho ficam nos detalhes técnicos. **Adicionar skill local** valida a pasta e mostra o conteúdo antes de copiar (para o projeto ou para as pessoais). Nada do conteúdo é executado ao catalogar. Na tarefa, a skill é registrada como **solicitada** e só vira **confirmada** com evidência: o nome aparece na lista de skills do processo que executou, ou o Claude Code chamou a ferramenta Skill. No OpenAI (Codex 0.58.0, sem mecanismo de skills) o manual vai como texto identificado e a confirmação fica "desconhecida".

**Ajustes → Conexões** — cartões separados para o Serviço da HQ, Claude Code e OpenAI/Codex, cada um com estado, último teste e a ação útil. "Conectado à HQ" não quer dizer que os provedores estão prontos.

**Fila que não depende da aba** — a execução é do serviço: fechar o navegador ou perder a conexão não cancela nada (provado com todas as abas fechadas). A fila fica no SQLite e sobrevive a reinícios. Se o serviço cair durante uma tarefa, ela é reconciliada ao voltar: se já tinha alterado arquivos ou rodado comandos, vira **resultado a conferir** e não é repetida sozinha; se não, volta para a fila como nova tentativa, até o limite de tentativas. Uma tarefa esperando autorização não segura a fila: tarefas independentes continuam.

**Limite de uso e queda de rede** — quando o Claude Code avisa que o limite da assinatura acabou ("You've hit your 5-hour limit"), a fila do Claude fica **suspensa até o horário de volta** informado pelo próprio CLI, com o motivo no cartão de cada tarefa. A tarefa interrompida volta sozinha na mesma conversa, dentro do limite de tentativas: se nada tinha sido feito, com o mesmo pedido; se já tinha avançado, com um pedido para continuar de onde parou conferindo o estado dos arquivos. Sem conexão com a API (ENOTFOUND e parecidos), a HQ tenta de novo depois de 1, 2, 5, 10 e 15 minutos, em vez de queimar a fila.

**Modo ausente** — botão **"Vou sair"** no cabeçalho (vira "Modo ausente ligado" quando está valendo). Você escolhe:
- os projetos que podem continuar e, se quiser, só alguns funcionários;
- o limite de tarefas, de minutos por tarefa e de tentativas;
- se rotinas podem disparar.

Antes de salvar, a tela mostra o que vai acontecer: a fila que continua, a que espera você, a próxima rotina, o que cada funcionário pode fazer sem perguntar (pelo modo de permissão dele) e os limites. Também mostra o que acontece ao fechar o navegador, bloquear a tela, sair da conta, suspender ou desligar, e como cada situação foi conferida (ao vivo, simulado ou não testado). A política é aplicada no servidor. Ausência não é aprovação: nenhuma permissão do Claude Code muda e o que precisa de você fica "Aguardando Chefe" enquanto o resto segue.

**"Enquanto você esteve fora"** — ao voltar, o resumo lista o que foi concluído, os arquivos produzidos, as falhas, o que está a conferir, as pendências, a fila e as rotinas que rodaram.

**Rotinas** — menu **Rotinas**. Você cadastra o pedido, o funcionário, o projeto, a skill (opcional), as permissões e quando roda: todo dia às HH:MM, em dias da semana ou a cada N minutos, sempre no horário de Brasília. A HQ não cria rotinas sozinha. O agendador é código, não chama modelo para olhar o relógio (checa a cada 30 s). Cada horário vira no máximo uma tarefa, e se a anterior ainda estiver aberta a rotina não empilha e registra o motivo. Horário perdido com a HQ desligada ou o computador suspenso (mais de 5 min de atraso) segue a regra de cada rotina: **pular** ou **rodar uma vez ao voltar**, nunca várias acumuladas. "Executar agora" cria a tarefa sem mexer na agenda. Apagar a rotina não apaga as tarefas que ela criou.

**Limites** (Ajustes → Geral) — tempo máximo por tarefa e tentativas automáticas, que valem para reinício, limite de uso e queda de rede.

## Marcos 0 e 1 (01/11/2026)

**Encontrar e dar trabalho sem andar** — **Buscar… Ctrl K** (cabeçalho) acha projetos, arquivos dos projetos, funcionários, skills e ações. Arquivo escolhido entra como contexto da tarefa. O **Armário de projetos** (o armário de cada sala, o Ctrl+K ou a ação "Armário de projetos") lista os projetos com favoritos e cliente, abre a pasta e deixa escolher **arquivos de contexto**, que vão para o pedido por referência (caminho no projeto, sem cópia). Na sala Desenvolvimento, a estante de livros abre as **Skills** e o rack abre as **ferramentas do projeto**. Clicar num objeto abre o painel na hora; o avatar só caminha até ele como animação.

**Modelo, esforço e Ultracode** — o botão ao lado do pedido mostra o que vale ("Sonnet 5.5 · médio · Ultracode") e abre modelo, esforço, **Ultracode** (chave separada: não é nível de esforço; o esforço escolhido continua) e permissões. Depois de executar, cada item aparece com o estado da evidência:
- **confirmado**: o Claude Code informou ao iniciar o processo (modelo, modo de permissão, servidores MCP);
- **enviado, não confirmado**: foi passado ao CLI, mas ele não informa de volta (esforço e Ultracode no 2.1.316).

**Conferir a entrega** — na aba Tarefas do funcionário, cada tarefa mostra a skill (pedida × confirmada), a configuração, o contexto, o resumo, os arquivos tocados e o diff. **Prévia local do projeto** abre o `index.html` do projeto num servidor da HQ em **outra origem** (porta própria, só leitura), para os scripts do site não alcançarem o token da HQ.

**Acessos dos funcionários** — cada funcionário tem a seção **Acessos**: por padrão, **nenhum servidor MCP** (antes herdavam todos os da sua conta, inclusive conectores do claude.ai). "Herdar todos" é escolha explícita. GitHub, `git push` e Vercel ficam **bloqueados para todos** em duas camadas: regra de negação no Claude Code (`gh`, `git push`, `vercel` nem chegam a pedir permissão) e ambiente sem credenciais (gh sem login, git sem credential helper nem SSH, sem tokens). Vale também para os turnos de reunião e para o Codex. A liberação controlada fica para a Central de Conexões (próximo marco).

**Dados e backups** — Ajustes → **Dados** mostra o banco em uso (arquivo, versão, tamanho, contagens), o último backup e as exclusões recentes. Backup automático diário (ficam os 7 mais recentes) e **Fazer backup agora**. Para restaurar: encerre a HQ e rode `node server/restore.mjs <backup> --yes`; o script confere integridade e relações (tarefa → conversa, falas → reunião…) e guarda o banco atual antes de trocar.

**Reuniões e exclusões** — excluir uma reunião manda para a **lixeira de reuniões** (embaixo da lista), com falas, quadro, contexto e ata, restaurável por 30 dias. Toda exclusão feita pela HQ (reunião, projeto, sala, rotina, pasta, arquivo, funcionário arquivado, conversa arquivada) fica registrada com origem no banco e no log.

## Sala Social Media (tela de entrada)

A HQ abre **dentro da sala Social Media**, em perspectiva isométrica. Cada objeto tem um nome curto sempre visível; clicar abre o painel na hora, e o avatar caminha até a frente do objeto e vira para ele (só animação). Sobre cada funcionário aparece um balão com o que ele faz de verdade: "pensando", o arquivo que está escrevendo, "precisa da sua permissão", "na fila" ou "parou com erro". Livre, sem balão.

- **Mesa do Chefe** ("Sua mesa", em âmbar com o número quando há algo para você): o que espera sua resposta (em qualquer perfil) e as peças do perfil para revisar.
- **Mesas dos funcionários**: abrem o painel do funcionário (conversa, tarefas e o bloco **Configuração** com função, provedor, modelo, esforço, skills, permissões, perfil e acessos). **Mesa vazia** abre a contratação já na sala Social Media.
- **Armário de mídia**: o explorador de arquivos na pasta cadastrada na sala. Sem pasta cadastrada, o explorador abre nas pastas que existem e avisa.
- **Mural de conteúdo**: na parede, quatro colunas com notas e contagens reais do perfil (Fila, Criando, Revisar, Pronto). No painel, cada peça abre a **prévia do arquivo entregue** (Markdown com títulos e negrito, texto ou imagem; vídeo abre no seu player), **Copiar legenda** (a seção "Legenda" do texto), Copiar texto, Abrir arquivo, **Pronto para postar** e Pedir ajuste (abre a conversa). "Pronto para postar" é a sua aprovação: postar é com você, fora da HQ. Nada aparece como agendado ou publicado.
- **Telinhas das redes** (IG, TT, IN na parede, apagadas): Instagram, TikTok e LinkedIn **não conectados**; o clique abre o mural com a contagem de peças por destino.
- **Estúdio de vídeo** (fundo de tecido, luz de anel e câmera): mostra se a skill `/milweb-video-studio` está instalada, começa um pedido de vídeo (roteiro de Reels ou TikTok, ideias de vídeos curtos, legenda para um vídeo) com a skill já escolhida e o cursor no fim do texto para você completar o tema, e lista as peças de vídeo da sala. Nada é gravado, editado ou publicado sozinho; se o campo já tiver texto, ele fica como está.
- **Mesa de reunião**: as reuniões e quem pode participar agora, com o estado real de cada provedor (por exemplo, "ChatGPT: login ok; resposta real pela HQ ainda não validada").
- **Porta**: abre o navegador de salas, o mesmo do topo.

**Topo**: MilWeb HQ, a sala atual (o navegador de salas: Social Media, Visão geral da empresa e as outras salas), o **perfil editorial** (Aurora ou Tuco Dev, lembrado neste navegador), a conexão e os Ajustes. O perfil vale para o mural, a mesa do Chefe e as tarefas novas; o destino escolhido em Opções vai no começo do pedido (`[Destino: Instagram]`) para o funcionário ler e o mural organizar.

**Menu**: Empresa, Equipe, Arquivos e Ajustes. Reuniões, Projetos, Rotinas, Skills, Lixeira, contratar e os objetos da sala ficam no **Ctrl+K**.

**Andar e olhar**: clique no chão anda; `WASD` e setas andam com o foco na cena; com o foco num campo de texto nenhuma tecla move o avatar. A sala se enquadra sozinha no espaço disponível (25% maior em 1366×768 do que no piloto) e volta a caber quando um painel abre, até você mexer no zoom ou arrastar. Roda do mouse ou `+`/`−` aproximam (de 0,75× a 3×), arrastar move a vista e **Centralizar sala** enquadra tudo de novo. Os objetos também têm botões para teclado: `Tab` a partir da cena mostra a fileira de objetos.

**Consumo**: a sala desenha só quando algo muda (avatar andando, ponteiro sobre um objeto, estado de um funcionário). Com um funcionário trabalhando, a animação (digitando e o balão) roda a 4 quadros/s. Parada, a página fica perto de 0% de CPU (medido: 0,01% a 0,14%). A sala pausa quando a janela está oculta ou quando outra vista está aberta.

**Arte**: original, desenhada em código em `web/src/scene/iso/socialRoom.ts` (formas geométricas, paleta da Aurora e os sprites de personagem que a HQ já tinha, de `web/src/scene/sprites.ts`). As telinhas das redes usam só iniciais e cores, não os logotipos. Não usa arte, código ou servidor do Habbo nem de clones dele.

## Central de Redes (contas sociais)

Sete destinos independentes. **Instagram · Aurora**, **Instagram · Tuco Dev**, **Threads**, **TikTok** e **LinkedIn** conectam pelas APIs oficiais de cada rede, sem serviço pago. **X · inglês** e **Pinterest** são manuais nesta etapa: a API do X cobra por uso e o Pinterest exige app aprovado. Abre pelo objeto **Redes** da sala, por "Redes: n/7 prontas" no topo (que fica separado de "HQ online", a conexão com o serviço), pelo Ctrl+K ou em Ajustes → Conexões. Pronta = conectada pela API ou com a conta confirmada por você para publicação manual.

- **Conta informada:** cada cartão aceita o @ e o link que você usa, separado da identidade devolvida pela API. Nenhuma conta vem pré-cadastrada e nada é inventado. O cartão do X tem o roteiro de criação da conta (nome, opções de @ sem afirmar disponibilidade, bio, imagens a partir do mascote, primeiro post); o do Pinterest, o da conta business gratuita.

- **Cada cartão** mostra a rede, o nome, o @ (quando a rede tem), o avatar, o ID devolvido pela rede, o tipo de conta, o perfil editorial associado e o estado. As ações são Conectar, Testar conexão, Reconectar e Desconectar, conforme o estado. Nada é inventado: o @ e o ID vêm da consulta à rede depois da autorização.
- **Capacidades separadas:** conta autenticada, leitura, publicação e agendamento. Cada uma aparece como **testada pela HQ** (a operação foi feita de verdade), **informada pela rede** (a permissão existe, mas a HQ ainda não executou) ou **indisponível** (com o motivo). Ler publicações não conta como publicação testada.
- **Conectar** abre a autorização da rede no navegador. A rede devolve o login para uma página HTTPS sua (as redes não aceitam localhost). O endereço padrão `https://aurora.example/hq-retorno.html` é só um exemplo: troque na central de Redes pelo de um site que você controla. Essa página repassa o código para a HQ local em `/social/oauth/callback`. A HQ troca o código pelo acesso, consulta a conta na rede e mostra a identidade.
  - A mesma conta não entra em dois cartões.
  - **Reconectar** exige a mesma conta: entrar com outra é recusado, e um Instagram nunca substitui o outro.
  - O Instagram pede o login de novo a cada autorização (`force_reauth`), para você escolher a conta certa.
- **Perfis:** o Instagram Aurora nasce associado ao perfil Aurora, e o Tuco Dev ao perfil Tuco Dev. Threads, TikTok e LinkedIn recebem o perfil depois de identificados (um, outro ou os dois). O perfil escolhido no topo filtra as contas oferecidas como destino.
- **Destino por conta:** o pedido grava o ID do cartão de destino na tarefa (`destination_id`). Trocar o perfil na tela não muda tarefas já criadas. O mural mostra as contas do perfil (com o Threads) e as peças de cada uma.
- **Publicar** só acontece quando você clica. A HQ publica **texto** no **Threads** e no **LinkedIn** (perfil pessoal), com uma tela de confirmação que mostra o destino e o texto. Cada envio tem um identificador e não publica duas vezes. Cada cartão oferece uma "publicação de teste" pronta para você conferir e disparar. Instagram e TikTok ficam como "a HQ prepara, você posta" (veja os limites).
- **Credenciais:** o App ID e o segredo de cada app, e os tokens de cada conta, ficam no **cofre do Windows** (DPAPI, em `%LOCALAPPDATA%\MilWebHQ\cofre`, que só o seu usuário abre). Ficam fora do banco, dos backups, dos logs e da tela. A interface só recebe a identidade, o estado e as capacidades.
- **Verificação:** ao iniciar e a cada 6 h, a HQ renova o acesso quando a rede permite (Instagram e Threads com 60 dias renováveis, TikTok com 24 h e renovação de 1 ano) e consulta a conta. Registra a hora da última verificação.
  - Sem rede, nada se perde: o cartão mostra a falha.
  - Acesso vencido ou revogado vira "Reconectar".
  - O LinkedIn vale 60 dias e não renova sozinho: o cartão avisa 7 dias antes.
- **Apps de desenvolvedor:** cada rede exige um app seu. Os passos ficam no cartão de cada app, com o endereço de retorno para copiar.

## Sala de conteúdo (equipe, Radar, Calendário e Resultados)

### Prioridade atual (desde 03/11/2026)

**Foco atual: Instagrams Tuco Dev e Aurora + Threads Aurora.** Mural → Radar → "Foco da sala" mostra e muda os dois controles, que ficam gravados no banco (valem depois de reiniciar e na retomada da fila):

- **Destinos** (produção, agendamento e publicação): ativos `instagram-tuco` (@tucoexemplo), `instagram-aurora` (@auroraexemplo) e `threads` (@auroraexemplo). TikTok, LinkedIn, X e Pinterest estão **pausados**: as peças deles ficam com o motivo, fora de "Para revisar", sem produção, revisão, aprovação, agendamento ou publicação (nem automática, nem por retentativa). Contas, conexões, históricos e arquivos ficam. Voltar um destino ao foco tira a pausa sem produzir nada sozinho.
- **Fontes de pesquisa**: Instagram, TikTok, X e Reddit, cada uma com o acesso real da última rodada (acessada, parcial, bloqueada). Pesquisar numa rede não libera produção nela.
- As outras redes só voltam quando a sala estiver entregando conteúdo utilizável, houver resultados observados nos dois Instagrams e o Chefe decidir expandir.
- **Capacidade**: no máximo 3 ideias do Radar na produção ao mesmo tempo; com 6 ou mais peças esperando a revisão do Chefe, o Radar não puxa ideia nova (fica no Radar).
- **Radar da gringa**: o Caio é o "Pesquisador de tendências — Radar da gringa" (pesquisa na web só leitura liberada no perfil dele). Rotina "Radar da gringa (pesquisa)" todo dia às 10:00 e 17:00 (ajustável em Rotinas; horário perdido roda uma vez ao voltar). A mesma publicação (URL normalizada ou id do post) atualiza a referência existente, sem cartão novo.
- **Usar como referência** (Radar → Enviar referência): imagem, vídeo, link ou texto; a referência entra como "Referência do Chefe" (mesmo sem link), o pesquisador analisa o que ela permite e o que não comprova, e a peça segue para a produção ligada a ela.
- **Vídeo**: a criação escreve `video.json` (sequência de cenas: o que aparece, o que acontece, o que fica claro, como a próxima continua) e a HQ renderiza com a composição `CenasReel` do projeto `remotion-video`, confere o MP4 (ffprobe), mede o movimento de cada cena e gera capa e quadros para a revisão. Render falho, arquivo inexistente e áudio provisório deixam a peça como entrega parcial.
- **Resultados**: cada peça registra a hipótese; depois de publicada, janelas de 24 h e 7 dias e a decisão (repetir, ajustar, testar outra abertura ou ritmo, abandonar).

### Referência de vídeo: colar o link, analisar com a equipe e produzir (04/11/2026)

- **Onde:** no campo "O que vamos criar?" da sala Social Media. Cole o link do vídeo (Instagram, TikTok, X, Reddit ou outro site) ou arraste o arquivo de vídeo; aparece o cartão com "O que gostei neste vídeo" (opcional), o perfil e dois botões: **Analisar com a equipe** (não produz nem posta) e **Analisar e produzir**. Escrever "quero um vídeo inspirado neste para o Tuco Dev" junto do link já sugere o segundo.
- **Inspeção pela HQ (local, sem custo):** o Edge sem janela abre o post (captura e metadados), o yt-dlp lê os dados públicos e baixa a mídia pública para análise interna (sem cookies: post que exige login fica bloqueado, com "Abrir para login", "Tentar novamente" e "Anexar vídeo"), o FFmpeg mede os cortes e gera folhas de quadros com a marcação de tempo, mede volume e silêncios, e o whisper.cpp do `remotion-video` transcreve a fala. O nível fica registrado (página, vídeo inteiro em quadros, com transcrição); música, efeitos e mixagem não são ouvidos e a análise diz isso.
- **Análise:** o pesquisador recebe as folhas de quadros anexadas como imagem (o modelo vê os quadros) e as evidências medidas; grava `analise-video.json` (contrato 1c) e `analise.md`.
- **Reunião:** a HQ abre uma reunião vinculada à referência com o pesquisador, a coordenação editorial, a criação e os gerentes Claude e ChatGPT (uma proposta, uma revisão e a síntese do gerente Claude; se um gerente sair por limite, o outro consolida). Só o pesquisador viu os quadros; os demais falam com base no relatório.
- **Produção:** no modo produzir, a síntese vira a peça (Reel, skill `milweb-video-studio`), a criação escreve o `video.json`, a HQ renderiza e confere, o revisor revisa e a entrega chega na Mesa. No modo análise, o cartão oferece **Produzir esta versão**.
- **Mesa e Radar:** o cartão mostra o progresso real (recebida, abrindo o vídeo, em análise, em discussão, proposta, em produção, renderizando, para revisar, bloqueada). O mesmo link reaproveita o cartão; a mesma referência pode render outra produção para outro perfil. No visualizador da peça, "Pedir ajustes" tem "Marcar o tempo do vídeo" e as versões anteriores aparecem na lista de arquivos.
- **Vários vídeos no mesmo pedido (05/11):** "igual a este <link> … pode ser esse áudio <link> … esse estilo <link>" vira uma referência só. O primeiro link é a base e cada outro recebe o papel pelo texto perto dele (áudio, estilo do vídeo, outra referência); o painel mostra os papéis e deixa trocar. Cada link é inspecionado na pasta `extra-N-<papel>/`, com evidências e folhas próprias, e tudo chega à análise, à reunião e ao briefing. Do link de áudio a HQ extrai o áudio; a criação marca o trecho e o instante em `audio-referencia.json` (contrato 3d) e, depois do render, a HQ gera `video-com-audio.mp4` ao lado do `video.mp4`, que fica sem o áudio de terceiros.
- **Botão principal:** com link de vídeo no texto, o Executar (e o Ctrl+Enter) vira "Analisar com a equipe" ou "Analisar e produzir" e segue este fluxo; a conversa comum com o funcionário fica no link "mandar como conversa comum para …" do painel. Link de artigo continua indo pelo envio comum.
- **Lixeira:** peça que saiu de uma referência e foi para a lixeira não volta pelo cartão: ele mostra "Peça na lixeira", não oferece "Produzir esta versão" e sai da Mesa (fica no Radar). Para recuperar, restaure pela Lixeira; para outra versão, cole o link de novo pedindo o vídeo.

A sala Social Media organiza o trabalho de conteúdo com quatro funcionários persistentes, que só sobem processo quando há tarefa (fila única, uma execução por vez, retomada e limite de minutos por fluxo):

| Funcionário | Função | Entrega |
|---|---|---|
| Marina | Coordenação editorial | Calendário de sete dias (`calendario/semana-<data>/calendario.json` e `.md`) |
| Caio | Pesquisador de tendências — Radar da gringa | Rodada do Radar (`radar/<data-hora>/oportunidades.json` e `radar.md`) e análise das referências do Chefe (`radar/entrada/<referência>/analise.json`) |
| Bia | Criação de conteúdo | Peça na pasta da marca (`marcas/<marca>/pecas/<data>-<rede>-<título>/`, com `peca.md` e `entrega.json`) |
| Otto | Revisão e análise | `revisao.json` da peça e a análise semanal (`resultados/analise-<data>/analise.json`) |

- **Preparar a sala** (cartão no Mural, idempotente): cria ou completa a pasta `projetos\hq-conteudos` dentro da sua pasta de usuário com o kit (`content-kit/` do repositório), a estrutura por marca e peça, o inventário dos originais (`referencias/originais.md`, por caminho, sem mover nada), a cópia de leitura das referências (`referencias/espelho/`: skill de vídeo, estudo do Instagram e Threads, textos dos episódios do Tuco Dev, capturas do portfólio), as quatro funções, as seis especialidades, a pesquisa do Radar (10:00 e 17:00) e a revisão semanal (sexta 17:00). Arquivo do kit que você editou nunca é sobrescrito.
- **Especialidades:** seis skills de projeto na pasta (`rede-instagram`, `rede-threads`, `rede-tiktok`, `rede-linkedin`, `rede-x`, `rede-pinterest`), curtas, sobre uma base comum (`equipe/base.md`, `equipe/contratos.md`, `equipe/funcoes/`) e as referências da `milweb-video-studio`.
- **Destinos com objetivo:** cada um dos sete destinos tem objetivo, público, idioma, pilares, conteúdo e indicador (matriz inicial do seu pedido, editável no Calendário → "Objetivos dos 7 destinos"). Conta, perfil editorial e plataforma ficam separados.
- **Mural → Radar:** até três prioridades por rodada, com fonte, autor, datas de publicação e de consulta, sinais, conta, leitura e proposta original, além do grau de evidência (referência pontual, tendência observada, hipótese, não verificado) e da cobertura real. "Virar peça" leva a oportunidade para o calendário.
- **Mural → Calendário:** "Preparar minha semana" pede o calendário ao coordenador. Cada peça tem objetivo, conta, formato, fontes, briefing, arquivos, estado do material (pronto, gravar, editar), responsável, data e critério de revisão. "Produzir" cria a tarefa da criadora; ao terminar, a HQ confere a entrega (tamanho do texto pela regra da rede, links, Pin renderizado em 1000×1500 pelo Edge local) e põe UMA revisão na fila. Depois disso a decisão é sua.
- **Aprovação em lote:** você escolhe peças e período; dentro do lote a HQ não pergunta de novo. Conta conectada com publicação de texto (Threads, LinkedIn) publica na data; as outras recebem o **pacote manual** (texto, arquivos, passos e o site oficial; no X o texto já vai pré-preenchido). Só vira "publicada" com resposta do provedor ou com o link conferido (oEmbed público no X e no TikTok; nas outras, o link precisa responder no domínio da rede, e a HQ diz que não viu o conteúdo). Sem confirmação, fica "publicação a conferir".
- **Mural → Resultados:** CSV simples (modelo em `resultados/modelo.csv`), número digitado ou captura como evidência (o revisor transcreve e os valores ficam "a conferir" até você confirmar). Valor vazio é "não coletado". A análise semanal entrega observado, promissor, ajustar e o próximo teste.
- **Mesa do Chefe:** no topo, o pedido ativo com o progresso real (uma linha por conta: pronta, em produção, parcial, pendente ou sem peça, com o motivo) e as entregas para revisar, cada uma com miniatura, conta, data, responsável e Abrir (visualizador da HQ: slides, vídeo e texto), Copiar texto do post, Pedir ajustes (volta para o mesmo responsável, no mesmo cartão), Arquivar e Excluir. Bloqueios mostram só o que pede você: autorização, falha, espera por limite e peça parada (falhou, planejada no pedido sem produção, conta sem peça e sem pesquisa rodando). As prioridades da pesquisa ficam no Radar.
- **Mural → Peças:** um cartão por peça (criação, revisão do Otto e refações ficam dentro dela; pesquisa não vira cartão). Filtros de marca, conta, período e estado; seleção com a contagem e lote (Arquivar, Mover para a lixeira, Restaurar) que respeita o filtro; Desfazer logo depois. Lixeira e arquivo preservam os arquivos e nunca removem nada das redes. Peça em execução mostra "Cancelar tarefa e mover para a lixeira" com o alcance (o que roda é interrompido, o que está na fila é cancelado); evento atrasado, retentativa ou reinício não fazem a peça voltar, e Restaurar não recomeça a produção. Pedidos avulsos (fora do calendário) aparecem à parte, com Arquivar e Excluir do cartão.
- **Entrega conferida:** "terminei" não basta. A HQ confere no disco o que o formato exige antes de "Para revisar": texto final (texto puro não exige mídia), imagens exportadas do carrossel (descrição não substitui), pin.png, ou o vídeo pronto listado na entrega (roteiro ou vídeo bruto citado não substitui). Faltou algo: "Entrega parcial", com o que existe e o que falta; a tarefa caiu: "Falhou", com o motivo e o próximo passo. Limite de uso: a peça segue a retomada automática.
- **Pedido do dia** (Calendário → Novo pedido do dia): dia, contas e observação. Liga as peças daquela data, cria as que vierem descritas e, com produção autorizada, manda para a fila; conta sem pauta espera a pesquisa, e o Radar concluído encaminha a produção sozinho.

## Visão geral da empresa (planta)

A planta vista de cima, com todas as salas, abre pelo navegador de salas, pelo botão **Visão geral da empresa** ou pelo seu nome no topo (Diretoria). **Voltar para Social Media** retorna. As outras salas continuam só nesta vista. Enquanto a sala Social Media está aberta, a planta fica pausada e os personagens só terminam de andar até as mesas quando ela é aberta.


- **Salas**: Desenvolvimento, Social Media, Design e Vídeo, Pesquisa e Prospecção, Gestão e Revisão e Diretoria (6 vagas de trabalho na planta) e a sala de **Reuniões** (lugar fixo, com mesa de reunião, cadeiras, tela e luz própria). Cada sala de trabalho tem mesas, um armário (Arquivos) e um mural (Tarefas), além de mobiliário próprio do tipo.
- **Funcionários** são contratados em `+ Funcionário` (ou automaticamente ao abrir a primeira conversa numa sala) e têm nome, função, aparência, sala, mesa, instruções, modelo, **esforço** e modo de permissão. Contratar não inicia nenhum processo. Um funcionário pode ter várias conversas guardadas; a **conversa ativa** é a que o personagem representa. Transferir de sala troca a mesa; arquivar tira o personagem da sala sem apagar nada (as conversas continuam consultáveis e retomáveis); restaurar devolve.
- **Estado do personagem** vem do servidor: disponível, na fila, em execução, aguardando permissão/resposta, pausado, interrompido, erro. Sessões abertas fora da HQ (terminal, agentes em segundo plano) aparecem como **observadas**, com marcação própria e sem botões de comando.
- **Controles do avatar**: `WASD` ou setas andam (há colisão com paredes e móveis, e as portas são o único caminho entre salas); clique no chão anda até o ponto; `E` interage com o que estiver ao alcance (a dica "E · …" aparece na tela); clicar num objeto interativo (ou num funcionário) leva o avatar até ele e interage ao chegar, mesmo que outro objeto esteja mais perto nesse momento. Com o foco num campo de texto, nenhuma tecla move o avatar. `Esc` fecha o painel/mural aberto ou volta ao escritório.
- **Interações**: funcionário → painel completo (chat, atividade, arquivos, entregas); mesa de funcionário → entregas dele; mesa livre ou mural → mural da sala (quem está nela, projetos, tarefas recentes); armário → explorador de arquivos na pasta do projeto da sala; balcão da recepção → equipe; **mesa ou tela da sala de Reuniões** → vista Reuniões (na reunião em andamento, se houver).
- **Câmera**: `Explorar` segue o avatar; `Ver empresa` (ou `Espaço`, que alterna entre os dois) enquadra a planta inteira; `+`/`−`, roda do mouse ou `0` (planta inteira) controlam o zoom; arrastar com o mouse solta a câmera; o minimapa no canto mostra salas, funcionários, você e o retângulo visível, e um clique nele move a câmera. A posição do avatar é lembrada entre aberturas.
- **Chat rápido**: a barra inferior está sempre acessível: escolha com quem falar em "Conversar com…", digite e `Enter` envia (ou enfileira, se o funcionário estiver ocupado). "Painel" abre o painel completo.

## Sala de reunião

A vista **Reuniões** (menu lateral, ou a mesa da sala na cena) lista as reuniões e abre o painel da selecionada: pauta e projeto no cabeçalho, participantes com estado real, a conversa, o quadro e as abas de contexto e ata.

- **Participantes**: Chefe, **Claude** (via Claude Code, a mesma instalação e assinatura dos funcionários) e **ChatGPT** (via Codex, rotulado "via Codex"). Cada participante de IA pode representar um funcionário (traz as instruções e o modelo/esforço dele) e pode ter modelo e esforço próprios só nesta reunião. Precedência: participante > funcionário > padrão global (Ajustes → Inteligência artificial). O servidor valida modelo e esforço antes de cada turno; configuração inválida falha com o motivo e as alternativas, nunca é trocada em silêncio.
- **Estados reais**: disponível, aguardando a vez, respondendo (texto parcial em tempo real), aguardando o Chefe, interrompido, indisponível (sem login, não instalado, falha). Na cena, Claude e ChatGPT entram pela porta, sentam à mesa com um rótulo do estado e saem quando a reunião termina.
- **Falar**: a mensagem vai para Todos, só para o Claude ou só para o ChatGPT (seletor), e menções `@Claude`/`@ChatGPT` no texto também contam. Cada destinatário responde uma vez, em sequência, vendo a fala real do anterior. "Decisão: …" numa fala sua vira decisão confirmada no quadro (concordância dos modelos não confirma nada).
- **Modos**: *Conversa guiada* (cada destinatário responde a cada fala) e *Discutir a pauta* (opinião inicial de cada um → rodadas de revisão em que cada um lê os outros → síntese com Propostas, Divergências, Perguntas abertas e Próximas ações, que vai para o quadro como itens não confirmados). Padrão 2 rodadas, limite configurável com teto absoluto de 6; "Mais uma rodada" acrescenta uma por vez.
- **Controles**: pausar, interromper (a fala parcial fica registrada como parcial e a reunião pausa), retomar, tentar de novo um turno que falhou, encerrar (gera a ata) e reabrir (volta pausada).
- **Contexto**: a pauta, o projeto, notas livres e arquivos escolhidos no explorador (só dentro de projetos e pastas cadastradas, lidos no servidor a cada turno, até 60 KB no total). Cada mudança incrementa a versão do contexto e cada turno/fala registra a versão que usou. O contexto da empresa (salas, projetos, funcionários) pode ser incluído ou não.
- **Quadro**: decisões (só o Chefe confirma), propostas, divergências, perguntas e ações com responsável; itens podem ser editados, descartados ou confirmados; linhas "Proposta:", "Divergência:", "Pergunta:" e "Ação:" numa fala entram automaticamente, sem repetir texto igual.
- **Ata** em Markdown, gerada ao encerrar e editável. **Criar tarefas** transforma ações/decisões em tarefas reais na fila do funcionário escolhido (idempotente: recarregar ou clicar de novo não duplica). "Criar sem iniciar" deixa a tarefa **em espera**; "Liberar" manda para a fila normal.
- **Paralelismo**: um turno de reunião conta como execução; com 1 execução por vez (padrão), o turno espera um funcionário terminar e avisa "Aguardando capacidade".
- **Modo análise**: nos turnos de reunião o Claude Code só pode ler (`Read`, `Glob`, `Grep`); qualquer pedido de permissão é negado pelo servidor. O Codex roda sem aprovações (todas negadas). Nenhum modelo executa nada durante a reunião.

## Inteligência artificial (Ajustes)

A aba **Inteligência artificial** mostra um cartão por provedor com dados reais: rota ("via Claude Code" / "via Codex"), instalação e versão, estado do login **sem mostrar credenciais** (só o método, ex.: "claude.ai · max" ou "ChatGPT · plus"), catálogo de modelos com os níveis de esforço que cada um aceita, modelo e esforço padrão, **Atualizar opções** (nova sondagem real) e **Testar conexão** (um turno curto real com a configuração escolhida; o resultado fica registrado no cartão). Para o Codex sem login há **Entrar com ChatGPT**, que abre o login oficial no navegador; a HQ nunca pede senha nem chave no chat. O Codex não é atualizado pela HQ: o cartão só avisa quando existe versão mais nova conhecida.

## Explorador de arquivos e lixeira

A vista **Arquivos** mostra o disco real: as raízes são as pastas dos projetos cadastrados e qualquer pasta avulsa que você adicionar ("Adicionar pasta"; nada é copiado). Uma ação só aparece como concluída depois da resposta do serviço.

- Ao sair da vista (Empresa, Lixeira…) e voltar, o explorador reabre na última raiz e pasta visitadas; abrir pelo armário de uma sala ou pelo mural vai direto à pasta do projeto.
- Navegação por árvore, breadcrumbs, busca por nome (ignora `node_modules`, `.git`, `dist`, `.next`, `.venv`), ordenação, seleção com `Ctrl`/`Shift`, menu de contexto (botão direito ou `Shift+F10`).
- Atalhos: `Enter` abre · `Alt+N` novo arquivo · `Alt+Shift+N` nova pasta · `F2` renomeia · `Ctrl+C`/`Ctrl+X`/`Ctrl+V` copia, recorta e cola · `Ctrl+A` seleciona tudo · `Ctrl+F` busca · `F5` atualiza · `Delete` envia para a lixeira · `Ctrl+S` grava o texto editado.
- Preview: texto (editável, com aviso de "não salvo"; se o arquivo mudou no disco desde a leitura, a gravação pede para recarregar ou gravar por cima), imagens (png, jpg, gif, webp, svg) e, para binários ou arquivos grandes, só as informações e "Abrir no programa padrão".
- Copiar/mover para outra raiz ou pasta: política explícita quando o destino existe (avisar, guardar com outro nome "nome (2)", ou substituir). Entre discos diferentes a cópia é verificada antes de apagar a origem.
- **Proteções**: nada fora das raízes (`..`, caminhos absolutos e links simbólicos/junctions são recusados, nunca seguidos); as pastas da própria HQ (dados, banco, lixeira, instalação) são protegidas; uma pasta usada por uma execução ativa (processo vivo ou tarefa em andamento) só sai do lugar depois que você escolhe "Interromper e continuar".
- O disco é observado: mudanças feitas por fora (pelo Claude Code ou por outro programa) recarregam a pasta aberta.
- **Lixeira**: tudo o que a interface apaga vai para `%LOCALAPPDATA%\MilWebHQ\trash` com registro de origem, tipo, tamanho e data. "Desfazer" no aviso e "Restaurar" na vista **Lixeira** devolvem ao caminho original (se já houver algo lá, só com outro nome: "nome (restaurado)"). "Excluir definitivamente" e "Esvaziar lixeira" pedem confirmação e aí sim removem do disco.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `packages/claude-bridge` | Controle do processo real (`ClaudeProcess`): argumentos (inclusive `--effort` e `--tools`), stdin/stdout em JSON, permissões (`control_request`), interrupção, retomada, redução de eventos em fases do funcionário. Testes com um CLI falso fiel ao protocolo e fixtures reais. |
| `packages/protocol` | Contrato servidor ↔ frontend (salas, projetos, funcionários, sessões, tarefas, chat, mensagens; `fs.ts` com explorador, pastas extras e lixeira; `ai.ts` com provedores, catálogo e preferências; `meetings.ts` com reunião, participantes, turnos, falas, quadro, contexto, ata e itens de tarefa). Versão 3. |
| `server` | Serviço local: loopback + token + checagem de origem, SQLite (`node:sqlite`) com migrações versionadas e backup antes de migrar, gerenciador de funcionários/sessões/fila (tarefas em espera), sessões externas observadas (`claude agents --json`), `src/fs/` (raízes, operações no disco, lixeira, observador), `src/ai/` (adaptadores: `claude/` por turno com `claude.exe`, `codex/` com o app-server JSON-RPC do Codex, `registry.ts` com precedência e validação) e `src/meetings/` (coordenador de turnos, banco e prompts da sala de reunião). Da v4: `src/skills/` (catálogo de skills e agentes), `src/routines.ts` (agendador), `src/service.ts` (controle do serviço e tarefa agendada), `src/provider-stop.ts` (limite de uso e queda de rede) e `launch.mjs` (lançador em segundo plano). |
| `web` | React + Vite: cena do escritório em canvas 2D (`src/scene`, pixel art procedural, sem assets de terceiros; sala de Reuniões no slot 6 com atores), casca da interface (`src/shell`: navegação, cabeçalho, barra de chat, equipe, projetos, minimapa), painel por funcionário (`src/panel`), explorador/lixeira (`src/files`), sala de reunião (`src/meetings`) e cartões de IA dos Ajustes (`src/settings`). |

Dados do usuário ficam em `%LOCALAPPDATA%\MilWebHQ`: `hq.sqlite` (banco), `backups/` (cópia `hq-v<N>-<data>.sqlite` feita antes de cada migração, via `VACUUM INTO`), `token`, `attachments/`, `logs/server.log` e `trash/`. Nada é gravado nas configurações do Claude Code (`~/.claude`) nem do Codex (`~/.codex`).

Desenvolvimento: `set MILWEB_HQ_DEV=1` e `pnpm --filter @milweb-hq/server dev` numa janela, `pnpm --filter @milweb-hq/web dev` noutra (Vite em `127.0.0.1:5173`, com proxy do WebSocket). Playgrounds com dados **de demonstração** (banner amarelo): `scene.html`, `panel.html` e `files.html`. Variáveis úteis: `MILWEB_HQ_PORT`, `MILWEB_HQ_DATA` (pasta de dados), `MILWEB_HQ_CLAUDE_PATH` e `MILWEB_HQ_CODEX_EXE` (executáveis alternativos).

## Segurança

- O serviço só escuta em `127.0.0.1`. O WebSocket exige o token (gerado por instalação, 256 bits) na primeira mensagem e recusa origens que não sejam a própria HQ (ou o Vite em desenvolvimento). O token nunca vai para o log.
- Prompts, respostas de permissão e anexos trafegam como JSON pelo stdin do processo; nunca são concatenados em linha de comando ou shell. O Codex é falado por JSON-RPC em stdio, sem shell.
- As permissões do Claude Code valem como sempre: cada pedido (`can_use_tool`) é mostrado no chat e só segue com a sua decisão. Não há modo `bypassPermissions` na interface. Nos turnos de reunião nenhuma permissão é concedida.
- Operações de arquivo são validadas no servidor: só dentro das raízes autorizadas, sem seguir links, com as pastas da HQ protegidas e nenhuma exclusão definitiva sem confirmação. Arquivos de contexto de reunião seguem a mesma regra.
- Credenciais não passam pelo frontend nem pelos logs (`logs/server.log` registra só eventos operacionais; a URL de login do Codex é aberta no navegador e só a origem dela vai ao log). A HQ não lê `~/.claude/.credentials.json` nem `~/.codex/auth.json`; o estado de login vem dos próprios CLIs.
- Nenhuma chamada paga nova: Claude pelo Claude Code (assinatura) e ChatGPT pelo Codex (conta ChatGPT). Nada em nuvem, nada instalado globalmente pela HQ.

## Limites conhecidos

- **Terminal embutido**: não incluído. A aba Terminal mostra o comando `claude --resume <id>` para abrir a mesma conversa no terminal (feche-a na HQ antes, para não haver dois processos no mesmo histórico).
- **Instruções da sala, do funcionário e do perfil** entram no system prompt quando a conversa é criada; mudanças depois valem para conversas novas. Modelo, esforço e modo de permissão podem mudar na conversa ativa (esforço só vale a partir do próximo processo).
- **Sessões externas** aparecem como observadas via `claude agents --json`, sem controle e sem detalhe de ferramenta. Elas não ficam no banco.
- **Paralelismo**: 1 execução por vez por padrão (Ajustes), contando turnos de reunião. Mais de uma execução simultânea compete por memória nesta máquina.
- **ChatGPT**: o Codex instalado é o **0.58.0** (a HQ avisa que existe o 0.166.0, mas não atualiza); o login com ChatGPT foi feito pelo Chefe em 01/11/2026 (o log mostra o login concluído), mas um turno real do ChatGPT pela HQ ainda não foi observado. Atualizar o Codex e provar essa resposta real é o começo do próximo marco.
- **Catálogo de modelos do Claude**: lista estática extraída do binário 2.1.314 em 31/10/2026 (o CLI não expõe uma listagem); se a versão instalada for outra, o cartão avisa e "Testar conexão" confirma o modelo de fato. O uso (`inputTokens` inclui cache; `costUsd`) é o que o CLI informa; na assinatura esse custo é nominal, não cobrança.
- **Tempo máximo por turno** de reunião: 10 minutos (depois disso a resposta parcial é mantida e o turno falha com o motivo).
- **Cena**: o assento de cada ator vem do servidor (0..5); o avatar do Chefe não senta à mesa (interage pela mesa/tela). A sala de Reuniões, os atores e a tela de reuniões foram verificados por testes e pela validação real por WebSocket, **não** por captura de tela no navegador nesta versão.
- **Vista geral**: o enquadramento usa o espaço real da cena. Em 1366×768 fica abaixo de 1 (cerca de 0,81, suavizado para não sumir linha de 1 px) e a planta aparece inteira. Em 1920×1080 fica em 1,25 (personagens maiores). O zoom manual (`+`/`−`, roda) continua inteiro; "afastar" abaixo da visão geral volta para ela. Na visão geral o minimapa some, porque a planta inteira já está na tela, e os atalhos ficam na barra de baixo, sem cobrir o mapa.
- **Explorador**: sem arrastar e soltar; markdown é mostrado como texto; listas acima de 2000 itens são truncadas (use a busca); a contagem de itens de subpastas só é feita quando é barata. O aviso de "em uso" considera a pasta do projeto inteira (apagar um arquivo dentro de um projeto com execução ativa não é bloqueado).
- **Limite de uso real** foi observado em 31/10/2026 (`rate_limit_event` com status `rejected` e `resetsAt`, depois um `result` de erro com `terminal_reason: api_error`). A suspensão da fila foi testada com um CLI falso que repete esse formato, não com um novo limite real. Ela vale para tarefas de funcionários; um turno de reunião que bater no limite falha com o motivo, como antes. A suspensão fica na memória do serviço: depois de um reinício, a primeira tentativa refaz a checagem.
- **Máquina**: nada roda com o computador desligado, suspenso ou fora da sua conta do Windows. Bloquear a tela, sair da conta e suspender **não foram testados** nesta máquina (testar mexeria na sua sessão). A HQ não impede o Windows de suspender: para trabalhar de madrugada, ajuste o plano de energia ("Suspender: Nunca" na tomada).
- **Iniciar com o Windows**: provado registrando e disparando uma tarefa com nome de prova (`Start-ScheduledTask`), não com um logon real. No logon, a janela do lançador pode piscar por um instante antes de sumir.
- **Rotinas**: a checagem é a cada 30 s (um disparo pode atrasar até isso). O fuso é sempre America/Sao_Paulo. Modelo e esforço por rotina existem no protocolo, mas a tela ainda não os oferece (valem os do funcionário).
- **Acessos**: o bloqueio de integrações evita o uso acidental e o caminho direto, mas não é um cofre. O funcionário roda como o mesmo usuário do Windows: um agente determinado ainda poderia ler arquivos de credenciais do perfil ou chamar APIs por conta própria. Isolamento forte exigiria outra conta do Windows ou sandbox. Rede em geral (`curl` para um site) não é bloqueada; só as credenciais saem do ambiente.
- **Esforço e Ultracode** não são confirmados pelo Claude Code 2.1.316 (o início do processo não informa); a tela mostra "enviado, não confirmado". O que a HQ enviou dá para conferir na linha de comando do processo.
- **Prévia local** serve sites estáticos (`index.html`). Sites com servidor de desenvolvimento usam a URL dele no mesmo campo.
- **Pastas temporárias antigas dos testes**: a causa foi corrigida (os testes apagam o que criam), mas as 466 pastas `hq-*` antigas em `%TEMP%` não foram apagadas automaticamente.
- **Opções da tarefa** (modelo, esforço, permissão) ficam valendo na conversa do funcionário depois da tarefa; o cartão mostra a configuração aplicada e a origem dela.
- **Redes sociais**:
  - **TikTok:** um app sem auditoria só posta como privado, com a conta privada, e a auditoria recusa ferramentas para as próprias contas. A HQ ainda não envia vídeo ao TikTok, e ler os vídeos exigiria o produto Display API.
  - **Instagram:** a rede publica só a partir de imagem ou vídeo num endereço público. A HQ não publica no Instagram e mostra a permissão como "informada".
  - **LinkedIn:** o caminho self-service publica no perfil pessoal. Página da empresa exige a Community Management API, aprovada pela LinkedIn só para empresa registrada. Ler publicações também é restrito.
  - **Agendamento:** nenhuma das quatro APIs agenda, e a HQ ainda não tem agendamento próprio.
  - A página de retorno fica no site da Aurora (`public/hq-retorno.html`). Se ela sair do ar, nenhuma conexão completa; a central mostra o resultado da conferência.
  - **X e Pinterest** não conectam nesta etapa: publicação manual com o link conferido.
- **Sala de conteúdo**:
  - **Pesquisa na web:** o `.claude/settings.json` da pasta de conteúdo libera WebSearch e WebFetch, mas o Claude Code só aplica essa regra numa pasta em que você confiou. Até lá, cada busca pede a sua autorização na HQ (aprovar com "sempre" resolve para a conversa daquele funcionário).
  - **Leitura fora da pasta** e **comandos de terminal** pedem autorização: por isso as referências vão copiadas para `referencias/espelho/` e o material de cada peça para `material/` na pasta dela.
  - **Sem vídeo renderizado** nesta etapa: a equipe entrega roteiro, texto, carrossel e Pin estático.
  - **Métricas** não são lidas das redes (nenhuma conta conectada com leitura): entram por CSV, captura ou digitadas.
- **Sala Social Media**: é a única sala em isometria; as outras continuam na planta. Publicar e agendar nas redes não existem (o destino só organiza o mural). O perfil escolhido no topo só vale para funcionários da sala Social Media: para quem está em outra sala, o pedido segue sem perfil e o cartão avisa. Tarefas antigas, sem perfil, não aparecem no mural filtrado por perfil (os pedidos de resposta aparecem na Mesa do Chefe em qualquer perfil). A prévia lê só arquivos dentro da pasta do projeto, até o limite do explorador (imagens grandes e vídeos abrem fora). "Copiar legenda" depende de o texto ter uma seção chamada Legenda, Caption ou Texto do post. Em telas estreitas as colunas do mural mostram só o número; o nome aparece ao passar o ponteiro. A Visão geral, quando aberta, consome como antes (cerca de 11% de CPU parada em 1920×1080).

## Validação

Testes automatizados: `pnpm test` (bridge com CLI falso e fixtures reais; servidor com fila, permissões, pergunta, interrupção, processo morto, reconciliação, funcionários, migração com backup v1→v2→v3, explorador e lixeira em disco real, adaptador do Claude com CLI falso, adaptador do Codex com app-server falso e coordenador de reuniões com adaptadores falsos; frontend com estado, cena com a sala de Reuniões, câmera, avatar, helpers do explorador, da reunião e dos Ajustes de IA). Os fluxos do briefing foram exercitados contra o Claude Code real com scripts de cliente WebSocket e de navegador (Edge headless, 1920×1080 e 1366×768); a sala de reunião foi validada de ponta a ponta por WebSocket com o Claude Code real e o Codex real sem login (27 verificações). A v4 foi validada em 01/11/2026 numa instância isolada com o Claude Code real: **23/23 verificações** (skill de projeto ativada e confirmada, envio duplicado, esforço inválido, provedor sem login, bloqueio por autorização com outra tarefa avançando, limite de uma execução, reinício forçado no meio do trabalho, conversa retomada depois do reinício, abas fechadas com Modo ausente, resumo de ausência, arquivos e lixeira). A etapa 4 foi validada no mesmo dia: **13/13 verificações**. Cobriram:
- lançador saindo com o serviço continuando, e sem segunda instância;
- estado real do serviço e pausar novas tarefas;
- Modo ausente com o serviço sem janela e sem aba;
- rotina disparando sozinha;
- tarefa agendada registrada no usuário, sem elevação;
- Encerrar HQ;
- 6 min desligada e religada pela própria tarefa agendada, com a rotina rodando uma vez só;
- remoção da tarefa de prova.
