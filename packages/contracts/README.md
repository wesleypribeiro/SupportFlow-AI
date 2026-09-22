# Contratos públicos

Implementação da task 2.1 de `language-school-sales-mvp`. O pacote depende somente
de Zod em runtime e pode ser utilizado pela API e pelo navegador. Não contém
repositórios, dados de demonstração da aplicação, execução de tools ou integração
com modelos.

## Exports

- `@supportflow/contracts`: todos os schemas e tipos.
- `@supportflow/contracts/chat`: mensagem, confirmação, erro HTTP e composição do
  envelope de resposta, sem dependência do segmento escolar.
- `@supportflow/contracts/language-school`: entidades, entradas e resultados das
  sete ferramentas, prévias e resposta completa do atendimento escolar.

Os tipos `School`, `CourseSummary`, `Course`, `Price`, `Contact`, `Lead`, `Slot`,
`TrialClass`, `Handoff` e os tipos de entradas, resultados e chat são inferidos dos
schemas por `z.infer`. Os schemas usam nomes em camelCase com sufixo `Schema`.

## Decisões de modelagem

1. **Objetos e valores:** todos os objetos são estritos, inclusive os aninhados.
   Não há coerção de tipos, defaults, geração de IDs/status ou preenchimento de
   campos ausentes. IDs são strings opacas não vazias, sem UUID ou prefixo imposto.
   Os valores são preservados; somente `message` é aparada, como exige a spec, antes
   da validação do limite de 1 a 2.000 caracteres.
2. **Preço:** `Price` é um objeto com `amountCents` inteiro não negativo, moeda
   `BRL` e `billingPeriod` igual a `month` ou `course`. `Course.price` é obrigatório
   e aceita esse objeto ou `null`. Zero é um preço cadastrado; `null` indica
   informação indisponível. Omissão não equivale a `null`.
3. **Dados institucionais:** a spec não detalha a estrutura de `address`, `contact`
   e `openingHours` da escola. Foram adotados textos não vazios, sem modelo de
   endereços ou grade semanal. O contato do lead é distinto: `{ type, value }`,
   discriminado entre `email` e `phone`.
4. **Telefone:** a spec exige formato válido, mas não define formato nacional ou
   internacional. A validação aceita de 7 a 15 dígitos, `+` inicial opcional,
   espaços, parênteses e hífens; não normaliza o número nem verifica sua existência.
   E-mails usam a validação de formato do Zod.
5. **Datas e fusos:** `startsAt` é uma string ISO válida com segundos e offset
   explícito (`±HH:MM` ou `Z` para UTC). Não é convertida em `Date`. `timezone`
   aceita um identificador IANA com `/`, reconhecido pelo `Intl` local, ou `UTC`.
   Um instante pode ser transmitido em UTC e apresentado no fuso da escola;
   não se exige igualdade textual entre offset e fuso. A validação não consulta
   relógio, disponibilidade ou serviços externos.
6. **Cursos:** entidades representam `active: true` e `active: false`. Os schemas
   dos sucessos de catálogo e da prévia de reserva exigem `active: true`, pois
   esses dados representam oferta pública. Isso rejeita dados inconsistentes;
   não implementa filtragem ou consulta de catálogo.
7. **Prévias:** cadastro expõe somente os argumentos definidos para `create_lead`.
   A reserva expõe `{ lead, course, slot }`, usando `CourseSummary` ativo para
   identificar o curso, sem exigir preço na prévia. Revisão, autorização,
   argumentos internos e vínculo com a conversa não fazem parte da ação pública.
   A indicação de agenda demonstrativa cabe à apresentação prevista na spec;
   não foi adicionado um campo comercial novo para essa indicação.
8. **Envelopes:** cada `{ tool, result }` associa um dos sete nomes à sua saída
   específica. Falhas usam os códigos de tool previstos no design, sem criar
   uma matriz adicional de códigos por operação. `CONFIRMATION_REQUIRED` é um
   resultado `ok: false`, que pode acompanhar uma prévia em resposta de chat
   bem-sucedida. Erros HTTP possuem seu próprio conjunto de códigos.

## Fronteiras de confiança

O navegador envia apenas `{ message, conversationId? }` ou
`{ conversationId, actionId }`. Não pode enviar `schoolId`, histórico, contexto,
resultados, revisão ou argumentos de negócio na confirmação. Os argumentos das
tools também não incluem autorização, contexto interno ou seleção de escola.

A função pequena `createChatResponseSchema` recebe os schemas de resultados e
ações do segmento, conforme o ponto de composição descrito no design. Não há
registro dinâmico de schemas. O módulo exporta a composição concreta
`languageSchoolChatResponseSchema`, sempre com `results` e `pendingAction`
obrigatórios, admitindo lista vazia e `null`, respectivamente.

Validar a estrutura não comprova origem dos dados nem autoriza uma ação. Verificar
referências existentes, vínculo/revisão da conversa, coerência lead/curso/slot,
horário futuro, disponibilidade, repetição e persistência continua sendo tarefa
dos futuros casos de uso do backend. Texto de `reply` não produz campos oficiais.

## Verificação

`npm test` executa os testes do pacote junto da suíte principal, sem rede ou
credenciais. `npm run typecheck --workspace @supportflow/contracts` inclui os
testes na checagem estática. O build usa `tsconfig.build.json` para emitir somente
os contratos e suas declarações, sem os arquivos de teste.
