# AGENTS.md

## Purpose

This repository uses OpenSpec/SDD and Codex-assisted development.

Treat this file as persistent operating guidance for coding tasks in this repository. Keep it concise and rely on the repository itself as the source of truth.

Before changing code, inspect the relevant implementation, tests, README files, and OpenSpec artifacts available in the working tree.

## Project

SupportFlow AI is a Full-Stack conversational AI application.

Current implemented vertical:
- language schools

Current expansion:
- WhatsApp as an additional channel

Primary stack:
- TypeScript
- Node.js 24
- npm 11
- Fastify
- Next.js / React
- Zod
- LangChain
- in-memory repositories
- Vitest

Workspace layout:
- `apps/api` — backend and conversation engine
- `apps/web` — frontend
- `packages/contracts` — shared public schemas and types
- `openspec` — SDD/OpenSpec plans and specifications when present locally

Main documentation:
- `README.md`
- `apps/web/README.md`
- `apps/api/src/modules/language-school/README.md`
- `packages/contracts/README.md`

## Development method

Development is task-oriented and follows OpenSpec.

When a prompt refers to an OpenSpec change:
1. Read its `proposal.md`, `design.md`, `tasks.md`, and relevant delta specs before coding.
2. Read relevant consolidated specs under `openspec/specs/` when available.
3. Implement only the explicitly requested task.
4. Do not start the next unchecked task.
5. Do not broaden the task because a future feature appears easy or related.
6. Mark only the requested task complete after its acceptance criteria are satisfied.
7. Do not archive an OpenSpec change unless explicitly requested.

If `openspec/` is ignored by Git but exists locally, it is still authoritative for the active SDD workflow. Do not infer that ignored means irrelevant.

## Scope discipline

Prefer the smallest correct change.

Do not:
- implement future milestones early;
- create speculative frameworks;
- add unrelated abstractions;
- rename public contracts without a requirement;
- alter business semantics to make tests easier;
- change existing test expectations merely to accommodate a regression.

If existing behavior conflicts with the requested specification, identify the conflict and resolve it according to the most specific current requirement.

## Architecture boundaries

Keep the reusable conversation core independent from business verticals and communication providers.

### Core

Code under reusable core layers must not depend on:
- Fastify when the component is intended to be transport-independent;
- React / Next.js;
- Meta / WhatsApp;
- language-school domain rules;
- concrete repositories from a business module.

### Language-school module

Keep business rules inside the language-school domain/application/infrastructure boundaries.

Domain and application code should not depend directly on:
- Fastify;
- React;
- LangChain unless the existing architecture explicitly places an adapter at that boundary;
- concrete infrastructure repositories.

### WhatsApp channel

Keep Meta-specific behavior under the WhatsApp channel/adapters.

Do not place Meta payloads, webhook logic, tokens, or Graph API details in the reusable conversation core.

The WhatsApp channel must reuse the existing conversation engine rather than create a second chatbot implementation.

## Business invariants

The LLM interprets and proposes. Deterministic backend logic validates and authorizes business state changes.

Never treat LLM prose as the source of truth for:
- prices;
- courses;
- slots;
- lead state;
- booking state;
- handoff protocol;
- receipts.

Official structured results and repositories are authoritative.

Preserve:
- one source of truth for pending actions;
- conversation isolation;
- revision-based invalidation;
- explicit confirmation where required;
- historical receipts;
- idempotent retries;
- atomic slot reservation semantics;
- deterministic fallback after a write when response wording fails.

A tool call alone does not authorize a protected write.

Generic free text such as `sim` must not silently authorize a booking when the architecture requires a specific pending action.

## Conversation concurrency

Operations for one conversation must remain serialized using the existing per-conversation mechanism.

Do not introduce:
- a global lock for all conversations;
- nested acquisition of the same conversation lock;
- a second independent source of ordering for the same operation.

Different conversations should remain able to progress independently.

## HTTP and contracts

Public HTTP contracts are defined by shared schemas and existing route behavior.

Keep validation strict.

Do not add fields to public request/response contracts unless the task explicitly requires it.

Internal adapters should call shared services directly. Do not call the application's own HTTP endpoints internally to reuse business logic.

## Tests

Use deterministic tests.

Prefer:
- real use cases;
- real in-memory repositories;
- `server.inject()` for Fastify integration;
- `ScriptedChatModel` for LLM behavior;
- simulated transports for external providers;
- controlled Promises for concurrency tests.

Avoid:
- arbitrary sleeps;
- real OpenAI requests in the normal test suite;
- real Meta requests in the normal test suite;
- dependence on local credentials;
- mocks that bypass the behavior being tested.

Do not silently remove or weaken regression tests.

## Required validation

For implementation tasks, run from the repository root unless the task explicitly narrows validation:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

When working on an active OpenSpec change and the CLI is available, also run its strict validation, for example:

```bash
openspec validate <change-name> --strict
```

Also run:

```bash
git diff --check
```

If a command cannot be run, state exactly why. Never claim a command passed unless it was executed successfully.

## Runtime requirements

Use the versions declared by the repository:

- Node.js: `>=24 <25`
- npm: `>=11 <12`

Do not change engine requirements merely because the current execution environment is older.

## External services

The normal automated suite must not require:
- OpenAI credentials;
- Meta credentials;
- WhatsApp connectivity;
- external databases;
- external calendars.

When a task requires compatibility verification against an external API, prefer current primary documentation.

For WhatsApp Cloud API behavior, prefer official Meta documentation and official Meta-maintained examples.

Do not use WAHA or an archived SDK unless the task explicitly requests it.

## Security

Never expose, print, commit, or copy real secrets.

Never commit:
- `.env`;
- access tokens;
- App Secrets;
- API keys;
- verify tokens;
- user credentials.

Keep secrets backend-only.

Do not add `NEXT_PUBLIC_*` variants for backend provider credentials.

Error messages and logs must not expose secret values, raw sensitive payloads, or internal stack traces unless a test explicitly uses non-sensitive sentinels.

Treat IDs from external providers as opaque strings unless the contract explicitly says otherwise.

## Generated and local files

Do not commit generated/local artifacts unless explicitly required:

- `node_modules/`
- `.next/`
- `dist/`
- `coverage/`
- local `.env` files
- ZIP archives
- temporary debugging files

Do not modify ignored OpenSpec history merely to make Git status cleaner.

## Git behavior

Do not commit, push, merge, rebase, force-push, or archive changes unless explicitly requested.

Do not amend existing commits unless explicitly requested.

Before concluding a task, inspect `git diff` / `git status` and report unrelated pre-existing changes separately.

Do not discard unrelated user changes.

## Task completion report

When finishing an implementation task, report concisely:
- task identifier;
- files created/changed;
- important architecture decisions;
- tests added;
- validation commands and results;
- total test count when available;
- any limitations or unresolved issues;
- confirmation that future tasks were not started.

Do not present a task as complete if its required checks failed.

## Human gate

After completing the explicitly requested task, stop.

Do not automatically continue to the next OpenSpec task.

The user/reviewer decides when to proceed.
