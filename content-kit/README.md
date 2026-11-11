# Conteúdos Aurora e Tuco Dev

Pasta de trabalho da sala Social Media do My Company AI. A HQ criou a estrutura; os arquivos antigos do Chefe continuam onde
estavam (o inventário com os caminhos originais fica em `referencias/originais.md`, e nada foi movido).

| Pasta | O que guarda |
|---|---|
| `marcas/aurora/` | **Equipe Aurora** (Instagram Aurora + Threads Aurora): `pecas/` (uma pasta por peça, `AAAA-MM-DD-rede-titulo`), `referencias/` (vídeos e links de referência da equipe) e `material/` (gravações, takes e prints do Chefe) |
| `marcas/tuco-dev/` | **Equipe Tuco Dev** (Instagram Tuco Dev): `pecas/`, `referencias/` e `material/`, do mesmo jeito |
| `radar/` | Rodadas do Radar (`oportunidades.json` + `radar.md`); `radar/entrada/` recebe links, capturas e exportações do Chefe |
| `calendario/` | Semanas preparadas pelo coordenador (`calendario.json` + `calendario.md`) |
| `resultados/` | CSV importados, capturas de evidência e análises semanais |
| `referencias/` | Inventário dos originais (vídeos, capturas, projetos) por caminho |
| `equipe/` | Base, funções, contratos de saída, destinos e fontes da equipe |
| `academia/` | Academia de Vídeo: `INDICE.md` (o que a equipe aprendeu), fichas das técnicas em `tecnicas/` e os estudos em `estudos/` (vídeo, análise, lição, exercícios e correção) |
| `.claude/skills/` | As seis especialidades por rede (Instagram, Threads, TikTok, LinkedIn, X, Pinterest) |

`.claude/settings.json` libera pesquisa na web (WebSearch e WebFetch, só leitura) para os funcionários desta pasta.
Publicar, agendar e enviar mensagens continuam fora do alcance deles.

Resultados em CSV: cabeçalho em `resultados/modelo.csv`. Valor vazio quer dizer "não coletado". Exemplo de linha:
`2026-11-04,instagram-aurora,https://www.instagram.com/p/<id>/,Contas alcançadas,312,,2026-11-04,2026-11-11,168,,abertura com resultado primeiro,`
