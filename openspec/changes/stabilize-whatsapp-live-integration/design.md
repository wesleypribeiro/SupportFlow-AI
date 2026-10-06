# Design — Estabilização da integração real

## Context

Inspeção em 2026-10-06, branch `fix/whatsapp-integration`, Node 24.21.0, npm 11.19.0, OpenSpec 1.13.1. Motivação e autorização delimitada: [proposal.md](proposal.md).

Os cinco arquivos inicialmente modificados foram examinados: `webhook-security.ts` aceita aliases opcionais com checagem de correspondência; `conversation-context.ts` descarta objetivo inferido mutando o patch e registra diagnóstico; `core/chat.ts`, `core/conversation-service.ts` e `infrastructure/langchain-context.ts` contêm somente instrumentação/reformatação de diagnóstico. Não há mudança comercial a preservar nesses três últimos.

`whatsapp-channel-mvp` tem 14/22 tasks marcadas até 5.2. Seu webhook já valida assinatura, origem e inbox; o serviço compartilhado faz staging/commit e revisão. Nenhuma dessas implementações será substituída. A capability `whatsapp-webhooks` ainda não foi consolidada: o delta desta change modifica o requisito da change ativa e deve ser reconciliado após ela numa eventual futura sincronização, sem criar uma segunda capability ou arquivar agora.

## Goals / Non-Goals

**Goals:** converter as duas correções experimentais em comportamento explícito e testado, eliminar diagnósticos temporários e preservar as garantias determinísticas existentes.

**Non-Goals:** interpretação NLP nova, relaxamento de nome/contato/referências, alterações de schemas públicos, prompt, confirmação, repositories, transporte, cliques da 5.3, novas funcionalidades ou homologação real nesta execução.

## Decisions

1. **Handshake restrito.** Manter `z.strictObject` com três campos oficiais obrigatórios e três aliases opcionais. A presença de qualquer alias exige os três e igualdade exata dos valores decodificados. Array, objeto, duplicação, escape inválido e extra continuam 400; trio coerente com token/mode incorretos continua 403. O token configurado continua comparado como buffers UTF-8 de mesmo comprimento com `timingSafeEqual`. Aceitar extras arbitrários ou aliases sozinhos foi rejeitado. POST/raw body/HMAC/limite não mudam.
2. **Goal validado sem mutar patch.** Validar o schema completo primeiro. Derivar o próximo objetivo apenas de valor vigente repetido ou valor com evidência literal, senão preservar o anterior. Remover apenas goal da lista de campos cuja ausência de evidência lança erro. Nome e contato continuam falhando atomicamente; curso e horário mantêm os resolvedores conservadores. Calcular revisão sobre os valores efetivamente validados. Não ignorar o patch inteiro, não capturar genericamente erros e não depender de mudança de prompt.
3. **Preservar o motor.** A limpeza devolve runner, serviço e interpretador ao comportamento anterior à instrumentação. Não tocar em `runExclusive`, staging, commit, recibos ou fluxo de confirmação. Objetivo descartado não cria mudança; nova proposta legítima ou outra alteração real mantém o lifecycle existente.
4. **Testes reais locais.** Reutilizar Vitest, `server.inject`, ScriptedChatModel, webhook assinado, transporte simulado e repositories reais. Cobrir formatos GET, logs sanitizados, goal isolado/misto, consultas de curso/preço, preservação de ação/revisão e cadastro somente após confirmação. Ajustar explicitamente os dois testes antigos que esperavam exceção/500 para objetivo sem fonte: esse comportamento é justamente o defeito autorizado; demais expectativas continuam.

## Risks / Trade-offs

- Uma intenção legítima parafraseada pelo modelo pode ser descartada → preservar o contexto é mais seguro que inventá-lo; o visitante pode esclarecer literalmente. Não há garantia semântica geral sobre texto livre.
- Os seis parâmetros são evidência do ensaio relatado pelo usuário, não uma afirmação de formato universal da Meta → aceitar apenas os dois formatos especificados e testar rejeições.
- OpenSpec está ignorado pela regra `openspec/` do `.gitignore` → manter artefatos locais e informar a limitação; não alterar ignore nem fazer staging forçado sem autorização.
- Memória volátil e ausência de execução de cliques da 5.3 permanecem limitações do produto, não escopo desta correção.

## Validation

Executar testes focados, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `openspec validate stabilize-whatsapp-live-integration --strict` e `git diff --check`. Registrar contagens e resultados após execução, sem credenciais/rede externa de provedores. Marcar exclusivamente a única task desta change quando tudo passar; não modificar tasks anteriores.
