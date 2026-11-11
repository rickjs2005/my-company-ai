---
name: my-company-ai
description: Installs, opens, updates and explains My Company AI, a local app that turns Claude Code into an AI-powered social media company with a team of agents (research, planning, content creation, review). Use when the person asks to "install My Company AI", "open my company", "set up my AI social media company", "update My Company AI", asks how to use it, or has trouble starting the service.
---

# My Company AI

My Company AI is a local app (a Node.js service plus a page in the browser, bound to `127.0.0.1`). You, the agent, help
the person install it, open it and use it. It is not a cloud service and has no price of its own: it uses the Claude
Code subscription (and, optionally, the Codex login) the person already has. The models do not run offline.

"My Company AI" is the app. The person's company has its own name, which they choose on the first run.

The interface is in Brazilian Portuguese. Keep the on-screen labels as written below and explain them in the person's
language.

Repository: https://github.com/rickjs2005/my-company-ai

## Before installing

Check these and say what is missing. Do not install anything on your own besides the project's dependencies.

- Windows 11. The launcher `start-hq.cmd` and "start with Windows" are Windows-only.
- Node.js 24 or newer (`node -v`) and pnpm 10 (`pnpm -v`; install with `npm install -g pnpm`).
- Claude Code installed and logged in (`claude auth status`).
- Optional: Codex CLI logged in, for ChatGPT as a meeting participant.

## Install

1. Ask which folder the person wants (suggestion: `~/projects/my-company-ai`). If something already exists there, do
   not choose for them.
2. `git clone https://github.com/rickjs2005/my-company-ai.git <folder>`. If the person already has the folder, use it.
3. In the folder: `pnpm install`, then `pnpm build`.
4. If the person wants to check the install: `pnpm typecheck` and `pnpm test`. The tests use a fake Claude Code and do
   not spend the subscription.

## Open

- Double-click `start-hq.cmd`, or run it from a terminal. It starts the service in the background on port 4777 and
  opens the browser. If the port is taken, run `set MILWEB_HQ_PORT=4790` first.
- Data lives in `%LOCALAPPDATA%\MilWebHQ` (database, logs, backups, credential vault). The folder keeps the project's
  original name for compatibility. Never read, copy or show the `token` file or the vault contents.
- To stop it: Ajustes → Conexões → Encerrar HQ. Do not kill the process while tasks are running unless the person asks.

## Company name (first run)

Before the office appears, the app shows **"Como se chama sua empresa?"** with the field **"Nome da empresa"** and the
button **"Criar minha empresa"**.

- The person types the name. Do not invent one for them and do not reuse the example brands as their company name.
- The local service validates and saves the name in its SQLite database; it survives reloads and restarts.
- To change it later: Ajustes → Empresa. Renaming does not rename teams, editorial profiles, social accounts, past
  deliveries or past conversations.

## First use (explain in this order)

1. **Connect an AI**: Ajustes → Conexões shows the real state of Claude Code and Codex.
2. **Prepare the Social Media room**: the card on the board creates the content folder with the team kit and hires the
   example team.
3. **Ask**: in "O que vamos criar?", write the request and leave the coordinator to plan and distribute. The app shows
   the brand, the kind of request and the expected delivery before sending.
4. **Review**: in Mesa (the desk), each delivery has Abrir (open), Aprovar (approve), Pedir ajuste (ask for changes) and
   Ver versões (versions).
5. **Teach**: Equipe → "Conhecimento da equipe", or write in the request "lembre disso para a equipe X". The guidance is
   stored and follows that team's next tasks.

## The example brands

The teams "Aurora" and "Tuco Dev" and the accounts `@auroraexemplo` and `@tucoexemplo` are fictional examples. They are
not real accounts and not the person's company. To use the person's own brands today:

- team names, colors and channels: `packages/protocol/src/teams.ts`;
- editorial focus of each team: `CONTENT_SQUADS` in `packages/protocol/src/content.ts` and the texts in
  `content-kit/equipe/`;
- real accounts: entered by the person in the networks panel, never by you.

After editing, run `pnpm typecheck`, `pnpm test` and `pnpm build`.

## Update

Close the app (Ajustes → Conexões → Encerrar HQ), then in the folder: `git pull`, `pnpm install`, `pnpm build`, and open
it again with `start-hq.cmd`. The service backs up the database to `%LOCALAPPDATA%\MilWebHQ\backups` before any
migration. An older clone named `milweb-hq` keeps working; point it at the new address with
`git remote set-url origin https://github.com/rickjs2005/my-company-ai.git`.

## Limits you respect

- Nothing is published to a network without the person approving it on screen. Do not publish, schedule or send
  messages for them.
- Do not put passwords, tokens or keys in files, examples or logs.
- The app does not use `ANTHROPIC_API_KEY`: the service removes it so usage stays on the subscription. Do not set it.
- Connecting networks through their APIs needs the person's own developer app in each network and an HTTPS return page
  they control. The default address `aurora.example` is only an example.
- The video skill `milweb-video-studio` is not in this repository. Without it, video tasks say the skill is missing.
- Do not promise automatic publishing, full video editing or integrations the person has not set up. Other rooms and
  departments are a future expansion, not part of the product today.

## Troubleshooting

- "Node.js não encontrado" or "pnpm não encontrado": install it and open a new terminal.
- Blank page: `pnpm build` was not run (the `web/dist` folder is missing).
- The service does not answer: read `%LOCALAPPDATA%\MilWebHQ\logs\server.log` and run `start-hq.cmd --janela` to see
  the output.
- "Abra pelo atalho": the page was opened without its access token. Run `start-hq.cmd` again.
- Claude Code logged out: `claude auth login`, then "Testar conexão" in Ajustes → Conexões.
- The company name screen reports it could not save: the service is unreachable. Check that it is running and retry.
