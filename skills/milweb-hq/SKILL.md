---
name: milweb-hq
description: Instala, abre e explica a MilWeb HQ, um escritório virtual local em que cada funcionário é uma sessão real do Claude Code (ou do Codex) produzindo conteúdo para redes sociais. Usar quando a pessoa pedir "instale a MilWeb HQ", "abra a HQ", "como uso a HQ", "atualize a HQ" ou tiver problema para subir o serviço.
---

# MilWeb HQ

A MilWeb HQ é um aplicativo local (serviço Node + tela no navegador, só em `127.0.0.1`). Você, agente, ajuda a pessoa a
instalar, abrir e usar. Não é um serviço na nuvem e não tem custo próprio: usa a assinatura do Claude Code (e,
opcionalmente, do Codex) que a pessoa já tem.

## Antes de instalar

Confira e diga o que faltar, sem instalar nada sozinho além das dependências do projeto:

- Windows 11 (o lançador `start-hq.cmd` e a tarefa "iniciar com o Windows" são para Windows).
- Node.js 24 ou superior (`node -v`) e pnpm 10 (`pnpm -v`; instala com `npm install -g pnpm`).
- Claude Code instalado e logado (`claude auth status`).
- Opcional: Codex CLI logado, para o ChatGPT participar das reuniões.

## Instalar

1. Pergunte em que pasta a pessoa quer a HQ (sugestão: `~/projetos/milweb-hq`). Não escolha por ela se já existir algo lá.
2. Clone o repositório de onde esta skill veio para essa pasta (`git clone <url do repositório> <pasta>`). Se a pessoa já
   tem a pasta, use a que existe.
3. Na pasta: `pnpm install` e depois `pnpm build`.
4. Rode `pnpm typecheck` e `pnpm test` se a pessoa quiser conferir a instalação (os testes usam um Claude Code falso e
   não gastam a assinatura).

## Abrir

- Dois cliques em `start-hq.cmd`, ou rode esse arquivo pelo terminal. Ele sobe o serviço em segundo plano na porta 4777 e
  abre o navegador. Se a porta estiver ocupada, use `set MILWEB_HQ_PORT=4790` antes.
- Os dados ficam em `%LOCALAPPDATA%\MilWebHQ` (banco, registros, cofre de credenciais). Nunca leia, copie nem mostre o
  arquivo `token` nem o conteúdo do cofre.
- Para encerrar: Ajustes → Conexões → Encerrar HQ. Não mate o processo com tarefas rodando sem a pessoa pedir.

## Primeiro uso (explique nesta ordem)

1. **Conectar uma IA**: Ajustes → Conexões mostra o estado real do Claude Code e do Codex.
2. **Preparar a sala Social Media**: cria a pasta de conteúdos com o kit da equipe e contrata a equipe de exemplo.
3. **Pedir**: no campo "O que vamos criar?", escreva o pedido em português e deixe "Gerente distribui". A HQ mostra a
   marca, o tipo de pedido e a entrega esperada antes de enviar.
4. **Revisar**: na Mesa, cada entrega tem Abrir, Aprovar, Pedir ajuste e Ver versões.
5. **Ensinar**: Equipe → "Conhecimento da equipe", ou escreva no pedido "lembre disso para a equipe X". A orientação fica
   gravada e acompanha os próximos trabalhos daquela equipe.

## Trocar as marcas de exemplo

As equipes "Aurora" e "Tuco Dev" e as contas `@auroraexemplo` e `@tucoexemplo` são fictícias. Para a pessoa usar as marcas
dela:

- nomes, cores e canais das equipes: `packages/protocol/src/teams.ts`;
- foco editorial de cada equipe: `CONTENT_SQUADS` em `packages/protocol/src/content.ts` e os textos em `content-kit/equipe/`;
- contas reais: informadas pela própria pessoa na central de Redes, nunca por você.

Depois de editar, rode `pnpm typecheck`, `pnpm test` e `pnpm build`.

## Limites que você respeita

- Nada é publicado nas redes sem a pessoa aprovar na tela. Não publique, agende nem envie mensagem por ela.
- Não coloque senhas, tokens ou chaves em arquivos, exemplos ou registros.
- A HQ não usa `ANTHROPIC_API_KEY`: o serviço remove a variável para a cobrança ficar na assinatura. Não a configure.
- Conectar redes pela API exige um app da própria pessoa em cada rede e uma página HTTPS de retorno que ela controle. O
  endereço padrão `aurora.example` é só exemplo.
- A skill de vídeo `milweb-video-studio` não vem neste repositório; sem ela, as tarefas de vídeo avisam que a skill não
  está instalada.

## Problemas comuns

- "Node.js não encontrado" ou "pnpm não encontrado": instalar e abrir um terminal novo.
- Tela em branco: faltou `pnpm build` (a pasta `web/dist` não existe).
- Serviço não responde: veja `%LOCALAPPDATA%\MilWebHQ\logs\server.log` e rode `start-hq.cmd --janela` para ver a saída.
- Claude Code deslogado: `claude auth login` e depois "Testar conexão" em Ajustes → Conexões.
