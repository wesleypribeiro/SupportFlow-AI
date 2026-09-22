# Chat da demonstração

A task 3.3 usa o App Router do Next.js com estado local no componente `Chat`.
Execute `npm run dev` na raiz e abra `http://127.0.0.1:3000`. O modelo e suas
credenciais são configurados exclusivamente na API; sem modelo, a interface
apresenta o erro controlado do backend e permite tentar novamente.

## Organização

- `src/app/chat.tsx`: histórico visual por turno, rascunho, ID da conversa, envio e
  erro recuperável. Um ref bloqueia submits simultâneos antes do próximo render.
- `src/app/chat-api.ts`: envia somente `{ message, conversationId? }` para
  `/api/chat` e valida a resposta com os schemas públicos Zod. Mensagens de erro
  para o visitante são locais e não exibem detalhes internos recebidos.
- `src/app/catalog-results.tsx`: apresenta escola, lista e detalhes exclusivamente
  dos resultados estruturados; formata centavos para BRL sem modificar os dados.
- `next.config.ts`: encaminha `/api/chat` para `http://127.0.0.1:3001/api/chat`.
  Não há API Route do Next nem configuração de LLM no frontend.

O primeiro envio omite `conversationId`. Após uma resposta válida, o ID retornado
é usado nos próximos envios. Cada turno preserva mensagem, `reply` e `results`;
o contexto interno do backend não é copiado. Recarregar a página ou escolher
“Nova conversa” descarta o ID e o histórico visual. Não há persistência no browser.

`reply` é texto simples. Somente `results` preenche os cards oficiais; não há
extração de fatos ou estados de operação da prosa. A lista contém os resumos que
a API fornece; os preços aparecem nos detalhes. `null` significa “Preço não
informado”, enquanto zero é mostrado como `R$ 0,00`. Não existem ações de confirmação.

Erros de rede, HTTP e resposta inválida preservam o rascunho. Reenviar o mesmo
texto falho reutiliza o turno visual, sem duplicar a mensagem. `404/NOT_FOUND`
bloqueia o ID removido e oferece “Iniciar nova conversa”, preservando o rascunho
para envio sem aquele ID. Uma falha não cria resposta fictícia do assistente.

## Testes e verificação visual

`npm test` executa 21 testes de interface no mesmo Vitest do projeto, usando
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
