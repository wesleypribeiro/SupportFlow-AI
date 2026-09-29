# Chat da demonstração

A interface das tasks 3.3, 4.4 e 5.4 usa o App Router do Next.js com estado local no componente `Chat`.
Execute `npm run dev` na raiz e abra `http://127.0.0.1:3000`. O modelo e suas
credenciais são configurados exclusivamente na API; sem modelo, a interface
apresenta o erro controlado do backend e permite tentar novamente.

## Organização

- `src/app/chat.tsx`: histórico visual por turno, rascunho, ID da conversa, envio e
  erro recuperável e prévia atual. Um ref compartilhado bloqueia mensagens e
  confirmações simultâneas antes do próximo render.
- `src/app/chat-api.ts`: envia somente `{ message, conversationId? }` para
  `/api/chat` e valida a resposta com os schemas públicos Zod. Mensagens de erro
  para o visitante são locais; 404 de confirmação usa a mensagem pública validada
  como texto. O helper `confirmChatAction` envia somente conversationId/actionId.
- `src/app/catalog-results.tsx`: apresenta escola, lista e detalhes exclusivamente
  dos resultados estruturados; formata centavos para BRL sem modificar os dados.
- `src/app/lead-results.tsx`: prévia e recibos de cadastro vindos exclusivamente
  de `pendingAction` e `results`.
- `next.config.ts`: encaminha `/api/chat` e `/api/chat/confirm` para o Fastify em `127.0.0.1:3001`.
  Não há API Route do Next nem configuração de LLM no frontend.

O primeiro envio omite `conversationId`. Após uma resposta válida, o ID retornado
é usado nos próximos envios. Cada turno preserva mensagem, `reply` e `results`;
o contexto interno do backend não é copiado. Recarregar a página ou escolher
“Nova conversa” descarta o ID e o histórico visual. Não há persistência no browser.

`reply` é texto simples. Somente `results` preenche os cards oficiais; não há
extração de fatos ou estados de operação da prosa. A lista contém os resumos que
a API fornece; os preços aparecem nos detalhes. `null` significa “Preço não
informado”, enquanto zero é mostrado como `R$ 0,00`.

Erros de rede, HTTP e resposta inválida preservam o rascunho. Reenviar o mesmo
texto falho reutiliza o turno visual, sem duplicar a mensagem. `404/NOT_FOUND`
bloqueia o ID removido e oferece “Iniciar nova conversa”, preservando o rascunho
para envio sem aquele ID. Uma falha não cria resposta fictícia do assistente.

## Testes e verificação visual

`npm test` executa os testes de interface no mesmo Vitest do projeto, usando
jsdom, Testing Library e user-event. O `fetch` é substituído por respostas
determinísticas; não são necessários navegador instalado, servidor, rede externa
ou credenciais para a suíte obrigatória. Os testes cobrem contratos, teclado,
envios simultâneos, continuidade, recuperação e separação de prosa e fatos.

Verificação de navegador da task 3.3: Chromium local, conduzido por Playwright
com respostas fictícias interceptadas, eventos reais de teclado e inspeção das
capturas. Playwright foi utilizado somente nessa verificação, sem adicioná-lo
como dependência ou requisito da suíte.

| Verificação | Resultado |
| --- | --- |
| Enter, Shift+Enter e Tab | Envio, quebra de linha e foco visível conferidos |
| Processamento | Campo e envio desabilitados, indicação visível |
| HTTP 500 e nova tentativa | Rascunho preservado, resposta recebida após repetir |
| HTTP 404 | Nova conversa explícita, próximo envio sem ID inválido |
| Escola, lista e detalhes | Dados apresentados em cards legíveis |
| Preço não informado e preço zero | Apresentações distintas conferidas |
| Prosa com preço divergente e alegação de reserva | Card manteve preço oficial e não criou confirmação |
| Desktop 1360×900, telas 390×844 e 320×740 | Sem transbordamento horizontal; histórico longo com rolagem |
| Recarregamento | Histórico visual e ID descartados |
| Proxy Next → Fastify sem modelo | `400/INVALID_REQUEST` e `500/CHAT_ERROR` preservados |

A avaliação em tela estreita foi feita no Chromium com viewport reduzido, sem
dispositivo físico ou teclado virtual móvel. Não houve chamadas reais à OpenAI.

## Prévia e confirmação do cadastro

`currentPendingAction` é um estado local explícito substituído a cada resposta
válida do backend. Exibimos somente a prévia atual, com nome, contato, identificador
do curso e objetivo. O contrato não fornece o nome do curso nessa prévia; nenhum
nome é inferido da prosa. Enviar uma correção bloqueia o botão até a resposta: mesmo
ID reabilita, novo ID substitui, null remove. Se o turno falhar, conserva a prévia.

“Confirmar cadastro” envia somente `{ conversationId, actionId }`, sem os dados da
prévia. Durante a confirmação, o composer e o botão ficam desabilitados. O sucesso
adiciona a prosa e o recibo oficial ao histórico e atualiza a ação atual. `created`,
`updated` e `existing` têm apresentação própria, sem interpretar a prosa como sucesso.
`CONFIRMATION_REQUIRED` apenas informa a necessidade de revisão, sem criar recibo.

`409/ACTION_STALE` remove a confirmação antiga e permite continuar conversando.
Falha de rede, 500 ou envelope inválido conserva a mesma ação e oferece “Tentar
confirmar novamente”, enviando exatamente o mesmo ID. O backend pode já ter gravado;
o retry recupera o recibo salvo, sem consultar o chat. 404 informa indisponibilidade
e oferece uma nova conversa; a UI não tenta distinguir ação desconhecida de conversa
removida, pois o contrato intencionalmente não revela essa diferença.

## Verificação da task 4.4

Revisão em Chromium local via Playwright, com inspeção das capturas, Next.js real
encaminhando para Fastify e `ScriptedChatModel` (sem OpenAI). O script temporário
não foi adicionado à suíte nem às dependências de produção.

- Catálogo, coleta de nome/contato/curso e prévia oficial conferidos.
- Enter envia, Shift+Enter insere linha, botão acessível por foco e processamento
  bloqueia novas operações.
- Corrigir email substituiu a única prévia visível. Confirmar o ID antigo via HTTP
  retornou 409; o novo ID criou somente o lead com contato corrigido.
- Nova correção de objetivo produziu updated com o mesmo lead ID. Foi simulada perda
  da resposta **após** o Fastify gravar: o retry enviou os mesmos IDs e recuperou um
  recibo exatamente igual. Nova chamada com dados idênticos retornou existing sem botão.
- Desktop 1360×900, viewports 390×844 e 320×740: campos, botão, erro e recibos legíveis,
  rolagem do histórico e ausência de transbordamento horizontal. Sem dispositivo
  físico/teclado virtual móvel; nenhum erro de execução no browser.

`chat-lead.test.tsx` adiciona cobertura determinística para prévia oficial, prosa
divergente, null no objetivo, created/updated/existing, corpo somente com IDs,
clique duplo, exclusão mútua entre chat e confirmação, mesma/nova/nenhuma ação,
409, 404, rede/500/envelope inválido e retry com o mesmo ID.


## Agenda e recibos de aula — task 5.4

`trial-class-results.tsx` apresenta listas de horários exclusivamente de `results`,
com data/hora formatadas em pt-BR no timezone oficial. Lista vazia não sugere vagas.
A prévia usa somente `pendingAction.preview`: aluno, nome do curso, data, hora,
fuso e aviso de agenda demonstrativa. Seu botão é “Confirmar aula experimental”.
O mesmo estado `currentPendingAction` e bloqueio de envio atendem cadastro e aula;
nenhuma autorização de cadastro é reutilizada. Enviam-se somente os dois IDs.

O recibo usa `schedule_trial_class` em `results`: created, existing ou
SLOT_UNAVAILABLE. O contrato do booking contém courseId, sem nome do curso; o recibo
exibe esse identificador oficial, sem inferir nomes da prosa. Prosa divergente não
cria sucesso ou altera dados, e uma falha de redação após a escrita usa o fallback
do backend. Retry de transporte conserva a mesma ação para recuperar seu recibo.

Verificação da task 5.4 em Chromium via Playwright local, Next e Fastify reais,
`ScriptedChatModel`, relógio fixo e sem OpenAI:

- Catálogo → curso → horários → escolha → cadastro confirmado → prévia de aula.
- Troca de 11/06 às 10h para 12/06 às 14h substituiu a prévia; ID anterior retornou
  409 e somente a nova ação confirmou a reserva.
- Falha da LLM após a escrita retornou created com mensagem de contingência.
  A resposta foi então perdida de propósito no transporte: repetir os mesmos IDs
  recuperou o recibo integral. Uma nova consulta da mesma reserva retornou existing.
- Ocupação por outro lead depois da prévia retornou SLOT_UNAVAILABLE, sem falso sucesso.
- Enter, Shift+Enter, foco, processamento e bloqueio de operações simultâneas conferidos.
- Desktop 1360×900, viewports 390×844 e 320×740: captura inspecionada, botões e
  data/hora/fuso legíveis, histórico com rolagem e sem transbordamento horizontal.
  Nenhum erro de execução no browser. Sem dispositivo físico/teclado virtual móvel.

`chat-trial-class.test.tsx` cobre lista/vazio, prévia oficial, labels distintos,
IDs exclusivos, prosa divergente, outcomes, clique duplo, mesma/nova/nenhuma ação,
stale e retry de rede/500/envelope inválido. A suíte permanece Vitest/Testing Library
sem rede externa; Playwright continua apenas uma ferramenta da verificação local.


## Solicitação humana local — task 6.2

`HandoffResults` renderiza apenas `transfer_to_human` de `results`: protocolo,
motivo original e status `requested` apresentado como “Solicitado”. Não lê `reply`,
não cria confirmação e não substitui `currentPendingAction`. A mensagem informa
que o registro é demonstrativo, sem atendimento ao vivo ou notificação externa.
Falhas têm aviso separado, sem card de sucesso; texto continua escapado por React.

Verificação visual em Chromium isolado (Playwright já disponível no ambiente),
com Next/Fastify reais e `ScriptedChatModel`, sem OpenAI ou tráfego externo:

- Pedido sem cadastro com falha de redação após a escrita: HTTP 200 e protocolo real.
- Repetição preservou protocolo e motivo, inclusive depois de nova falha simulada.
- Cadastro confirmado e pedido posterior funcionaram na mesma conversa.
- Oferta explícita seguida de “Sim, por favor” registrou solicitação sem cadastro.
- Prosa simulada que alegava atendente conectado não apareceu na resposta do backend.
- Enter enviou; capturas de 390×844 e 320×740 foram inspecionadas. Protocolo quebra
  linha, motivo/status/aviso ficam acessíveis pela rolagem e não há overflow horizontal.

`chat-handoff.test.tsx` cobre apresentação oficial, prosa divergente, repetição,
falhas, HTML como texto, status inválido rejeitado e prévia anterior preservada,
sem envio automático para `/api/chat/confirm`. A suíte usa Vitest/Testing Library.
