<div align="center">

# Red Bean · 年糕

**An AI agent chat platform.** Streaming conversations, tool calling, sub-agent delegation,
scheduled tasks, and a full audit trail for every run — built on a runtime SDK that can be
embedded anywhere.

[![CI](https://github.com/cuteVanilla12138/red-bean-nian-gao/actions/workflows/ci.yml/badge.svg)](https://github.com/cuteVanilla12138/red-bean-nian-gao/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.9.0%20%3C26-brightgreen)](package.json)

**English** · [简体中文](README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/conversation-dark.png">
  <img alt="A Red Bean conversation: reasoning steps, tool calls, and a delegated sub-agent" src="docs/assets/conversation.png">
</picture>

## Why this exists

Most agent frameworks grow a long tail — a chat UI here, a database adapter there, an HTTP
server somewhere — until the "framework" is really an application. That makes the agent loop
hard to embed in anything else, and harder still to reason about what a running agent is
actually permitted to do.

Red Bean splits the problem in two:

- **[`red-bean-qing-tuan`](https://github.com/cuteVanilla12138/red-bean-qing-tuan)** — an embeddable
  TypeScript runtime SDK. It owns the agent loop, checkpointing, interrupts, and a
  vendor-neutral observability seam. It knows nothing about HTTP, databases, or UI.
- **This repository** — the product. It owns sessions, persistence, authentication, the
  HTTP/SSE surface, scheduled tasks, and the design system.

Three consequences worth calling out:

1. **The capability graph is fixed at boot.** Each backend instance assembles its runtime,
   observability adapters, LLM providers, and tool catalog at startup, and never installs or
   replaces capabilities while running. What an instance can do is decided once, not
   negotiated per request.
2. **Every run is auditable.** Runs are recorded to an append-only fact log and surfaced in a
   read-only trajectory view: which tools ran, how long each step took, how many tokens each
   request cost.
3. **The runtime is versioned like a dependency.** `runtime.lock` pins the SDK to an exact
   commit; `make verify` refuses to run against a mismatched or dirty working tree.

## Features

| Feature | What it does |
| --- | --- |
| **Streaming conversations** | Server-sent events with reasoning blocks and a process timeline that folds long tool sequences into a readable summary. |
| **Tool calling** | A static `sys_*` catalog — file read/write, glob, grep, HTTP, time, todos — registered at boot and authorized per agent. |
| **Sub-agent delegation** | A parent run hands work to a child agent and folds the child's progress into its own timeline. |
| **Interrupt & resume** | Any tool can suspend a run to ask a human. The interrupt is an execution barrier: no other tool in the batch runs before the answer arrives. |
| **Scheduled tasks** | Cron-driven runs with retry policy, a delivery queue, and their own execution history. |
| **Session trajectory** | A read-only audit view over the run fact log, with per-request token accounting and timing. |
| **Design system** | A component library with Light/Dark parity, shipped as a runnable showcase site. |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/scheduled-tasks-dark.png">
  <img alt="Scheduled tasks: definitions, plans, and the latest run side by side" src="docs/assets/scheduled-tasks.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-run-dark.png">
  <img alt="A scheduled run: the automatic execution is folded into the same timeline reading as a conversation" src="docs/assets/task-run.png">
</picture>

## Architecture

```text
┌─────────────┐   HTTP / SSE    ┌──────────────┐   AgentExecutionPort   ┌──────────────────────┐
│  frontend   │ ──────────────▶ │   backend    │ ─────────────────────▶ │  red-bean-qing-tuan  │
│ React + Vite│ ◀────────────── │   Fastify    │ ◀───────────────────── │  (runtime SDK)       │
└─────────────┘                 └──────┬───────┘   pinned by runtime.lock└──────────────────────┘
                                       │
       ┌───────────────┬───────────────┼───────────────┬───────────────┐
       ▼               ▼               ▼               ▼               ▼
  PostgreSQL        Redis           MinIO       api-contract    design-system
  (sessions,      (buffers,      (objects,     (shared DTOs,   (Quiet Tool UI,
   run facts,      locks)         uploads)      routes, codes)  Light/Dark)
   tasks)
```

Four workspace packages plus the sibling SDK:

- **`api-contract/`** — the machine-executable source of truth for HTTP routes, SSE events,
  DTOs, error codes, and runtime validation. Both frontend and backend depend on it; neither
  re-declares its shapes.
- **`backend/`** — Fastify, `pg` with explicit SQL, a composition root that wires everything
  once at boot, and modules (`agent`, `task`, `identity`, `storage`, `system`) that depend on
  ports rather than each other.
- **`frontend/`** — React 19 + Vite. Consumes the contract and the design system.
- **`design-system/`** — the Quiet Tool UI component library, with a showcase site that
  renders every component in both themes. A drift check fails the build if the frontend
  imports a component that doesn't exist, or if a public component has no showcase page.

The backend reaches the runtime SDK through a single `AgentExecutionPort`. Ordinary chat,
scheduled tasks, and sub-agents all share one executor and differ only in their product
lifecycle.

## Quick start

**Prerequisites:** Node.js `>=24.9.0 <26`, pnpm 11.x, Docker. Run `make doctor` to check all
of them at once.

```bash
git clone https://github.com/cuteVanilla12138/red-bean-nian-gao.git
cd red-bean-nian-gao
make init                # toolchain · pinned runtime SDK · workspace deps · backend/.env.local

# fill in database/Redis/MinIO passwords, a JWT secret, and an LLM key
$EDITOR backend/.env.local

make infra-up && make db-migrate
make run                     # backend  → http://localhost:8080
pnpm --filter frontend dev   # frontend → http://localhost:5173
```

`make init` is the one-shot entry point: it checks the toolchain, clones the runtime SDK
alongside this repository, checks out the revision pinned in `runtime.lock`, builds it, installs
the workspace, and copies `backend/.env.local.example` into place. It never overwrites an
existing `.env.local`, and re-running it is safe.

`make bootstrap` clones the SDK into a sibling directory named `red-bean-qing-tuan`, because the
backend consumes it through the relative link `link:../../red-bean-qing-tuan`. The directory name
is load-bearing; the GitHub repository name is not. Re-running it is safe: an already-correct
checkout and build are left alone. If you keep the SDK elsewhere, pass `SDK_DIR=<path>`.

The design system showcase runs the same way and needs neither the backend nor an LLM key:

```bash
pnpm --filter design-system dev   # → http://localhost:5174
```

## Quality gates

Everything runs locally and offline; no external services are required.

```bash
make doctor         # toolchain versions and package declarations
make docs-check     # living-doc index, markdown links, cross-client skill source
make secrets-check  # env ignore policy and high-confidence secret scan
make fmt            # rewrite files (this is the fixing command)
make verify         # backend + frontend + design system + contract + docs + sibling SDK
make verify-full    # adds real-infrastructure integration tests and a dependency audit
```

`make verify` covers four packages and the pinned SDK. `make fmt` is the only command that
writes to tracked files.

Optional Git hooks, installed per clone (they are never installed automatically):

```bash
make hooks-install   # pre-commit runs verify-quick, pre-push runs verify
```

## Project layout

```text
red-bean-nian-gao/
├── api-contract/     Shared API contract: DTOs, routes, error codes, validation
├── backend/          Fastify service: sessions, tasks, storage, agent execution
├── frontend/         React app: chat, trajectory audit, scheduled tasks
├── design-system/    Quiet Tool UI library and showcase site
├── docs/             Living design docs, ADRs, and the documentation index
├── runtime.lock      Pinned red-bean-qing-tuan revision
└── Makefile          Single task entry point
```

## Documentation

- [`docs/README.md`](docs/README.md) — index of all living docs and decision records
- [`docs/design/backend/architecture.md`](docs/design/backend/architecture.md) — layering and dependency direction
- [`docs/design/agent/pipeline.md`](docs/design/agent/pipeline.md) — the main session pipeline and hooks
- [`docs/design/session/session-trajectory.md`](docs/design/session/session-trajectory.md) — the audit view's information architecture
- [`docs/decisions/`](docs/decisions/) — ADRs: what was chosen, what it cost, what it rules out
- [`backend/STACK.md`](backend/STACK.md) — backend technology choices and the reasoning behind them
- [`AGENTS.md`](AGENTS.md) — the development conventions this repository is held to

## The runtime is a separate repository

The agent loop, checkpoint semantics, interrupt barriers, and tool safety policy live in
[`red-bean-qing-tuan`](https://github.com/cuteVanilla12138/red-bean-qing-tuan). That split is
deliberate: the runtime has no production dependencies and no knowledge of this product, so
it can be embedded in a CLI or a different host entirely.

The two repositories are coupled only by `runtime.lock`. To upgrade: commit in the SDK, then
update the lock file here and run `make verify`.

## License

[MIT](LICENSE)
