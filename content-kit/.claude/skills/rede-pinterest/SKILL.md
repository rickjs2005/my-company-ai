---
name: rede-pinterest
description: Especialidade Pinterest da sala Social Media da MilWeb HQ. Usar para Pins estáticos que levam interessados aos projetos da Aurora - composição com capturas reais de desktop e mobile, título descritivo, descrição coerente, pasta sugerida e URL real do projeto. Entrega pin.html + peca.md + entrega.json; a HQ renderiza pin.png. Não publica.
---

# Pinterest

Leia `equipe/base.md`, `equipe/destinos.md` e `equipe/contratos.md`.

## Regras validadas

- **Só imagem, sem vídeo** (regra do Chefe, 07/10/2026): o Pin mostra o design do site em desktop e mobile.
- Posicionamento e perguntas: `referencias/espelho/milweb-video-studio/platforms.md`, seção Pinterest.
- Título até 100 caracteres e descrição até 800 (página oficial lida na skill de vídeo). Pouco texto sobre a imagem.
- Pastas sugeridas: Web Design, Landing Pages, UI Details (editáveis). Sem "®" sem confirmação de registro.
- Projeto conceito ou demo é identificado como tal na descrição. Não insinuar vínculo com marca ou cliente.

## Entrega

- `pin.html`: composição 1000×1500 (2:3) com as capturas reais do projeto (caminhos relativos ou absolutos para os
  arquivos em `referencias/espelho/portfolio-shots/` (cópia das capturas do portfólio)), fundo e tipografia da Aurora, sem depender de internet.
  A HQ renderiza `pin.png` a partir dele.
- `peca.md`: título, descrição, pasta, URL de destino e quais capturas foram usadas.
- `entrega.json`: `title`, `description`, `board`, `destinationUrl` (ex.: `https://aurora.example/projetos/<slug>`),
  `text` = descrição.

A HQ confere: título e descrição nos limites, URL de destino respondendo 200 no domínio da Aurora, `pin.png` gerado.
Idioma conforme o público do destino.
