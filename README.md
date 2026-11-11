# My Company AI

**Build your own AI-powered social media company on your PC.**

My Company AI is a local app that turns Claude Code into a small social media company with a team of AI agents. You name
the company, hire agents with roles (coordination, research, content creation, review), ask for content in plain
language, and review what the team delivers before anything leaves your computer.

The app runs on your machine: a Node.js service bound to `127.0.0.1` and a page in your browser. The AI models do
**not** run offline. Every agent is a real Claude Code session (and, optionally, a Codex session for ChatGPT), so the app
needs an internet connection and your own Claude Code login, and it is subject to your provider's plan and usage limits.

> **Language.** The interface and the agents' working instructions are in Brazilian Portuguese today. This README, the
> install skill and the troubleshooting guide are in English. An English interface is on the roadmap.
> A detailed screen-by-screen reference in Portuguese is in [docs/README.pt-BR.md](docs/README.pt-BR.md).

## What it is

"My Company AI" is the name of the app. **Your company has its own name**, which you choose the first time you open it.

The current product is one department: a **social media company**. Inside it you get:

- **Agents with roles.** Each agent is a persistent employee (name, role, instructions, model, permissions). An agent
  only starts a Claude Code process when it has a task.
- **Research.** A researcher agent collects references and trends into a "Radar" with sources and an evidence level.
- **Planning.** A coordinator agent turns a request into a plan and a weekly calendar, one piece per account and format.
- **Content creation.** A creator agent writes posts, captions, carousels and video scripts into a folder on your disk.
- **Review of deliveries.** A reviewer agent checks each piece, and the app checks on disk that the files the format
  needs really exist. Then the piece waits on your desk: open, approve, ask for changes, see versions.
- **Supporting tools for that work:** meetings where you discuss a topic with Claude and, optionally, ChatGPT; a file
  explorer with a recycle bin; scheduled routines; a queue that survives closing the browser and restarting the service.

Nothing is published to a social network unless you click to publish it.

## Requirements

| What | Notes |
|---|---|
| Windows 11 | The launcher (`start-hq.cmd`) and "start with Windows" are Windows-only. Other systems are not supported yet. |
| Node.js 24 or newer | `node -v` |
| pnpm 10 | `npm install -g pnpm` |
| Claude Code, installed and logged in | `claude auth status`. The app uses your Claude subscription through Claude Code. It removes `ANTHROPIC_API_KEY` from the agents' environment so usage stays on the subscription. |
| Optional: Codex CLI, logged in | Only for ChatGPT as a meeting participant. Without it, meetings run with Claude alone. |
| Optional: video tooling | Video analysis and rendering use FFmpeg, yt-dlp, a Remotion project and a separate video skill (`milweb-video-studio`) that is **not** in this repository. Without them, video tasks say what is missing. |

## Install

There are three separate things: the **application** (this repository), the **install skill** (a small guide for Claude
Code, in `skills/my-company-ai`), and the **optional dependencies** listed above.

### With Claude Code (recommended)

```powershell
git clone https://github.com/rickjs2005/my-company-ai.git
xcopy /E /I my-company-ai\skills\my-company-ai "%USERPROFILE%\.claude\skills\my-company-ai"
```

Then, in Claude Code, run `/my-company-ai` or ask "install My Company AI". The skill checks the requirements, installs
the dependencies, builds the interface and opens the app.

### By hand

```powershell
git clone https://github.com/rickjs2005/my-company-ai.git
cd my-company-ai
pnpm install
pnpm build
start-hq.cmd
```

`start-hq.cmd` starts the service in the background on port 4777 and opens your browser. If the port is taken, run
`set MILWEB_HQ_PORT=4790` first.

## Choose your company name

On the first run, before the office appears, the app asks **"Como se chama sua empresa?"** ("What is your company
called?"). Type the name and press Enter or click **"Criar minha empresa"**.

- The name is validated and saved by the local service in its SQLite database, so it survives reloading the page,
  closing the browser and restarting the computer.
- It appears in the header, in the browser tab title and in the context the agents receive for new work.
- Change it any time in **Ajustes → Empresa** (Settings → Company). Renaming does not rename teams, editorial profiles,
  social accounts, past deliveries or past conversations.

## Your first task

1. **Connect an AI.** Ajustes → Conexões shows the real state of Claude Code and Codex.
2. **Prepare the Social Media room** (card on the board). It creates a content folder with the team kit and hires the
   example team.
3. **Ask.** In "O que vamos criar?" write what you want, for example a week of posts about a subject, and send it. The
   coordinator plans and distributes the work; you can also pick one agent directly.
4. **Watch.** Each agent shows what it is really doing: thinking, writing a file, waiting for your permission, queued.

## Review the delivery

Open **Mesa** (your desk). Each delivery has Open, Approve, Ask for changes and Versions. A piece only reaches your
desk after the app confirmed on disk that the expected files exist; otherwise it is shown as a partial delivery with
what is missing. Approving does not publish anything.

## About the example teams

A new install has no employees, no connected accounts and no personal data. It does ship with two **fictional example
brands**, "Aurora" and "Tuco Dev", as the two built-in teams, with placeholder accounts (`@auroraexemplo`,
`@tucoexemplo`) and a placeholder address (`aurora.example`). They are examples, not real accounts, and they are not
your company's name. Today the team names are defined in code (`packages/protocol/src/teams.ts` and
`CONTENT_SQUADS` in `packages/protocol/src/content.ts`); editing them in the interface is on the roadmap.

In the interface, the person who runs the company is called "Chefe" (boss): that is you.

## What was verified for this release

Checked on Windows 11 with Claude Code 2.1.322, on an isolated data folder:

- `pnpm typecheck`, `pnpm test` and `pnpm build` pass. The tests use a fake Claude Code, so they do not spend your plan.
- A new install shows the company name screen and saves a custom name.
- The name survives a page reload and a service restart.
- Ajustes → Empresa renames the company without changing rooms, profiles or other settings.
- An empty name is rejected by the interface and by the service; accents and non-Latin names work; a double click does
  not create a second configuration.
- A simple task run with the real Claude Code after naming the company: the agent answered with the configured company
  name and the app name. The same is covered in the test suite with the fake Claude Code.
- A fresh clone installs and builds with the commands in this README (`pnpm install`, `pnpm build`).

Implemented and documented, but **not re-verified for this release**: publishing text to Threads and LinkedIn through
their official APIs (requires your own developer app in each network and an HTTPS return page you control), video
analysis and rendering, meetings with ChatGPT through Codex, and "start with Windows".

## Limitations

- Windows only. Interface in Brazilian Portuguese only.
- The models run at your provider, not on your PC. Speed, quality and availability depend on your Claude Code (and
  Codex) plan, configuration and usage limits. When a usage limit is reached, the queue waits until the provider's
  reset time.
- No automatic publishing. The app never posts on its own. Instagram, TikTok, X and Pinterest are "the app prepares,
  you post". Text publishing to Threads and LinkedIn exists only after you connect your own developer apps.
- No scheduling on the networks.
- No complete video editing. The team delivers scripts, text, carousels and static images; rendered video depends on
  the optional tooling above and may be delivered as partial.
- Metrics are not read from the networks; you enter them by CSV, screenshot or by hand.
- One task runs at a time by default.
- Agents run as your Windows user. The app blocks the direct paths to GitHub, `git push` and Vercel for agents, but it
  is not a sandbox.

## Update

```powershell
cd my-company-ai
git pull
pnpm install
pnpm build
```

Close the app first (Ajustes → Conexões → Encerrar HQ) and open it again with `start-hq.cmd`. When the database format
changes, the service makes a backup in `%LOCALAPPDATA%\MilWebHQ\backups` before migrating.

If you cloned this repository under its previous name (`milweb-hq`), GitHub redirects the old address. To point your
clone at the new one: `git remote set-url origin https://github.com/rickjs2005/my-company-ai.git`.

## Configuration

| Setting | Where |
|---|---|
| Company name | Ajustes → Empresa |
| AI providers, models, effort | Ajustes → Conexões |
| Parallel runs, time and retry limits | Ajustes → Geral |
| Backups and restore | Ajustes → Dados |
| Port | `MILWEB_HQ_PORT` (default 4777) |
| Data folder | `MILWEB_HQ_DATA` (default `%LOCALAPPDATA%\MilWebHQ`) |

Internal identifiers keep the project's original name on purpose, so existing installs keep working: the data folder
`%LOCALAPPDATA%\MilWebHQ`, the `MILWEB_HQ_*` environment variables, the `@milweb-hq/*` workspace packages, the
`start-hq.cmd` launcher and the "MilWeb HQ" scheduled task.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "Node.js não encontrado" / "pnpm não encontrado" | Install it and open a new terminal. |
| Blank page | Run `pnpm build` (the `web/dist` folder is missing). |
| The service does not answer | Read `%LOCALAPPDATA%\MilWebHQ\logs\server.log`, or run `start-hq.cmd --janela` to see the output in a window. |
| "Abra pelo atalho" (open from the shortcut) | The page was opened without its access token. Run `start-hq.cmd` again. |
| Port 4777 in use by another program | `set MILWEB_HQ_PORT=4790`, then `start-hq.cmd`. |
| Claude Code logged out | `claude auth login`, then "Testar conexão" in Ajustes → Conexões. |
| Tasks stay queued | Check Ajustes → Conexões: a provider without login, a usage limit, or "pause new tasks". |
| The name screen says it could not save | The service is not reachable. Check that it is running and try again; nothing is stored only in the browser. |

## Security and privacy

- The service listens only on `127.0.0.1` and requires a per-install token. The token is never logged.
- Your data stays in `%LOCALAPPDATA%\MilWebHQ` (database, logs, backups, recycle bin). Social network credentials are
  kept in a Windows DPAPI vault, outside the database, backups and logs.
- Claude Code permissions apply as usual: each permission request is shown and waits for your decision.

## Roadmap

- More rooms and departments beyond social media. The other rooms visible in the company overview are early and are not
  the product yet.
- Edit teams, brands and channels in the interface instead of in code.
- English interface.

## Development

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Layout: `packages/claude-bridge` (drives the real Claude Code process), `packages/protocol` (contract between service
and interface), `server` (local service, SQLite, queue, meetings, content pipeline), `web` (React + Vite interface),
`content-kit` (the team's working instructions), `skills/my-company-ai` (install skill).

## License and authorship

MIT, see [LICENSE](LICENSE). Created and maintained by [rickjs2005](https://github.com/rickjs2005). The project was
first published as "MilWeb HQ". The fonts in `server/assets/carrossel/fonts` keep the OFL license that ships with each.
