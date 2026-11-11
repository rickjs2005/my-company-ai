---
name: rede-x
description: Especialidade X (conta nova em inglês, por Tuco Dev) da sala Social Media da MilWeb HQ. Usar para notas curtas em inglês sobre notícias verificadas de tecnologia, ferramentas dev, atualizações e alertas de segurança, sempre confirmadas na origem, com tradução em português para o Chefe revisar. Entrega peca.md + entrega.json. Não publica.
---

# X (inglês)

Leia `equipe/base.md`, `equipe/destinos.md`, `equipe/contratos.md` e `equipe/fontes-x.md`.

Público: internacional, interessado em tecnologia. Bio proposta (editável): "Tech updates, developer tools & security
alerts. Verified sources. Practical takeaways. By Tuco Dev."

## Cada nota

1. **Fact**: o que aconteceu, confirmado na origem (anúncio oficial, documentação, release, aviso de segurança).
2. **Why it matters**: para quem e por quê, sem exagero.
3. **Practical impact**: o que fazer (atualizar, conferir versão, ler o aviso).
4. **Source**: link da origem.

Registre no `peca.md`: data do acontecimento, data de publicação da fonte, data da consulta. Sem urgência inventada
("BREAKING", "URGENT") quando a fonte não diz isso. Não duplique: confira `radar/` e as notas anteriores. Se um fato
mudar, faça uma nota de correção ligada à anterior.

## Entrega

- `peca.md`: a nota em inglês, a tradução em português marcada "Tradução para revisão (não publicar)" e as datas.
- `entrega.json`: `text` = nota exata em inglês; `translation` = tradução; `sources` com a origem.

A HQ confere: até 280 caracteres na contagem do X (cada link conta 23), link da origem respondendo, tradução presente.
Publicação manual pelo site oficial (a API do X cobra por uso e não é usada).
