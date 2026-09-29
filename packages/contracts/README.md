# Contratos públicos

Pacote compartilhado entre API e navegador, com **Zod como única dependência de runtime**. Não contém repositories, fixtures, execução de tools, regras de persistência ou integração com modelos. Consulte o [README principal](../../README.md#contratos-e-endpoints) para uso da API.

## Exports

| Import | Conteúdo |
| --- | --- |
| `@supportflow/contracts` | Todos os schemas e tipos exportados. |
| `@supportflow/contracts/chat` | Mensagem, confirmação, erro HTTP e composição genérica do envelope. |
| `@supportflow/contracts/language-school` | Entidades, entradas/resultados das sete tools, prévias e envelope escolar. |

Os tipos são derivados dos schemas por `z.infer`, incluindo `School`, `CourseSummary`, `Course`, `Price`, `Contact`, `Lead`, `Slot`, `TrialClass` e `Handoff`. Schemas usam camelCase com sufixo `Schema`. Os exports apontam para `dist`, gerado pelo build do pacote.

## Valores e validação

- Objetos são estritos, inclusive aninhados. Não há coerção de tipos, defaults, geração de IDs/status ou preenchimento pela LLM. IDs são strings opacas não vazias, sem UUID/prefixo obrigatório.
- Valores são preservados. Somente `ChatRequest.message` é aparada antes de validar 1 a 2.000 caracteres.
- `Price` contém `amountCents` inteiro não negativo, `currency: BRL` e `billingPeriod: month | course`. `Course.price` é obrigatório e aceita `Price | null`: `null` é informação indisponível; zero é preço cadastrado. Omissão não equivale a `null`.
- `School.address`, `School.contact` e `School.openingHours` são textos não vazios, sem estrutura de endereço/grade semanal adicional.
- Contato do lead é `{ type: email | phone, value }`. E-mail usa o formato Zod; telefone aceita 7 a 15 dígitos, `+` inicial opcional, espaços, parênteses e hífens. Não normaliza nem verifica a existência do contato.
- `startsAt` é ISO válido com offset (`±HH:MM` ou `Z`), preservado como string. `timezone` aceita fuso IANA com `/` reconhecido pelo `Intl` local, ou `UTC`. O schema não consulta clock ou disponibilidade; compatibilidade com escola/slot é validada no backend.
- Entidades de curso permitem ativo/inativo; sucessos de catálogo e prévia da reserva exigem `active: true`. Schemas não filtram nem consultam o catálogo.
- `TrialClass.status` é somente `confirmed`; `Handoff.status`, somente `requested`.

Fontes: [shared.ts](src/shared.ts), [entities.ts](src/language-school/entities.ts) e [tools.ts](src/language-school/tools.ts).

## Entradas e resultados das sete tools

| Tool | Entrada estrita | `data` de sucesso |
| --- | --- | --- |
| `get_school_info` | `{}` | `{ school }` |
| `get_courses` | `{}` | `{ courses }` com resumos ativos |
| `get_course_details` | `{ courseId }` | `{ course }` completo e ativo |
| `get_available_slots` | `{ courseId }` | `{ courseId, slots }`; lista vazia é válida |
| `create_lead` | `{ name, contact, courseId, goal }` | `{ outcome: created \| updated \| existing, lead }` |
| `schedule_trial_class` | `{ leadId, slotId }` | `{ outcome: created \| existing, booking }` |
| `transfer_to_human` | `{ reason }` | `{ request }` com ID, motivo e status |

Nas células acima, as alternativas de enum são notação de tipos, não JSON. Todas as saídas seguem `{ ok: true, data }` ou `{ ok: false, error: { code, message } }`. Códigos de tool: `INVALID_INPUT`, `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `ACTION_STALE`, `SLOT_UNAVAILABLE`, `OPERATION_FAILED`.

`languageSchoolToolResultSchema` associa cada `{ tool, result }` ao schema correto, sem payload oficial livre. `CONFIRMATION_REQUIRED` é falha esperada da tool, acompanhada de prévia em um turno HTTP 200; não significa falha técnica de transporte. Nenhuma entrada aceita `confirmed`, `conversationId`, revisão ou autorização produzida pela LLM.

## Chat e confirmação

[chat/index.ts](src/chat/index.ts) define:

```typescript
import {
  chatRequestSchema,
  chatConfirmationRequestSchema,
} from '@supportflow/contracts/chat';

chatRequestSchema.parse({ message: 'Quais cursos vocês oferecem?' });

// IDs ilustrativos: na chamada HTTP use os retornados pelo backend.
chatConfirmationRequestSchema.parse({
  conversationId: 'id-retornado-pelo-backend',
  actionId: 'id-da-previa-retornada',
});
```

O navegador pode enviar somente `{ message, conversationId? }` ou `{ conversationId, actionId }`. Histórico, `schoolId`, contexto, results, argumentos comerciais e configurações de modelo não fazem parte desses contratos.

[language-school/chat.ts](src/language-school/chat.ts) compõe `languageSchoolChatResponseSchema`:

- Campos obrigatórios: `conversationId`, `reply`, `results`, `pendingAction`.
- `reply` é texto não vazio; não constitui resultado oficial.
- `results` pode ser vazio, mas cada item deve corresponder ao schema de sua tool.
- `pendingAction` é `null`, ou `{ actionId, kind, preview }`.
- `kind: create_lead`: preview igual a `CreateLeadInput`, sem ID do lead.
- `kind: schedule_trial_class`: preview `{ lead, course, slot }`, com resumo ativo de curso, sem preço/descrição extras.

Revisão, estado interno, argumentos internos e autorização não são publicados. Não existe pending action de handoff.

O envelope de erro HTTP é `{ error: { code, message } }`. O schema admite `INVALID_REQUEST`, `NOT_FOUND`, `ACTION_STALE`, `SLOT_UNAVAILABLE` e `CHAT_ERROR`; a rota atual publica conflito de vaga **em results com HTTP 200**, e usa HTTP 409 para `ACTION_STALE`. A presença de um código no schema não determina, sozinha, seu status HTTP.

## Limite de responsabilidade

Schema válido não prova origem, consentimento, disponibilidade ou vínculo à conversa. Casos de uso/repositories implementados no [módulo escolar](../../apps/api/src/modules/language-school/README.md) validam referências, contexto, futuro, disponibilidade, repetição e persistência. O core verifica lifecycle e confirmação por IDs. Prosa de `reply` nunca se transforma em fatos oficiais.

## Verificação e build

Na raiz, `npm test` inclui os testes do pacote na suíte sem rede/credenciais. `npm run typecheck --workspace @supportflow/contracts` inclui testes na checagem estática. `npm run build --workspace @supportflow/contracts` emite contratos e declarações, excluindo arquivos de teste por [tsconfig.build.json](tsconfig.build.json).

O build principal e os pre-scripts de testes/desenvolvimento/checagem das aplicações já compilam o pacote quando necessário. Não edite `dist` manualmente.
