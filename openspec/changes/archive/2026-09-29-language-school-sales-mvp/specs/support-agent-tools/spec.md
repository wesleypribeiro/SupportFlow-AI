# Spec Delta

## Purpose

Disponibilizar ferramentas de atendimento escolar com contratos estritos e resultados oficiais produzidos pelo backend, separando linguagem natural, fatos comerciais e autorização de operações.

## ADDED Requirements

### Requirement: Ferramentas registradas com contratos estritos

O sistema SHALL disponibilizar somente `get_school_info`, `get_courses`, `get_course_details`, `get_available_slots`, `create_lead`, `schedule_trial_class` e `transfer_to_human` neste módulo. Cada entrada e saída MUST ser validada contra seu schema estrito, inclusive objetos aninhados, sem coerção nem campos adicionais. Resultados SHALL usar `{ ok: true, data }` ou `{ ok: false, error: { code, message } }`, com `data` específico da ferramenta e mensagem de erro controlada pelo backend.

As entradas SHALL ser: `{}` para escola e lista de cursos; `{ courseId }` para detalhes e horários; `{ name, contact: { type, value }, courseId, goal }` para lead, com `goal` texto ou `null`; `{ leadId, slotId }` para reserva; e `{ reason }` para solicitação humana. Strings obrigatórias SHALL ser não vazias; `contact.type` SHALL ser `email` ou `phone`. Identificadores, contato e dados de cada operação MUST respeitar as respectivas capabilities. Contexto da conversa e autorização de escrita MUST ser fornecidos pelo backend, não por argumentos produzidos pelo modelo.

#### Scenario: Argumentos incompatíveis
- **WHEN** a LLM pede ferramenta desconhecida ou envia argumentos com campo obrigatório ausente, tipo incorreto ou propriedade extra
- **THEN** o sistema rejeita a chamada sem executar consulta ou escrita, com erro controlado

#### Scenario: Saída inválida
- **WHEN** uma operação produz resultado fora do schema
- **THEN** o sistema não o publica como dado oficial nem o entrega à LLM como resultado válido

### Requirement: Origem estruturada dos fatos e resultados oficiais

Preços, horários, disponibilidade, dados da escola, cursos e resultados de cadastro e agendamento MUST ser obtidos exclusivamente dos dados estruturados validados do backend/tools. O sistema MUST montar os resultados oficiais enviados ao chat a partir desses dados, nunca a partir da prosa gerada pela LLM. A LLM MUST NOT ter acesso direto aos repositórios ou ser instruída a produzir esses fatos a partir do próprio conhecimento. A instrução do agente SHALL direcioná-lo a consultar ferramentas e informar ausência de dados quando necessário.

O sistema SHALL permitir texto natural para diálogo e explicação dos resultados. Esse texto MUST NOT ser utilizado como evidência de cadastro, reserva ou disponibilidade, nem como entrada autoritativa de outra operação. Esta especificação estabelece a origem dos dados do sistema; não estabelece garantia absoluta sobre toda frase produzida por um modelo probabilístico.

#### Scenario: Preço vindo da fonte oficial
- **WHEN** o usuário pergunta o preço de um curso
- **THEN** o sistema obtém os detalhes pela ferramenta e preenche o resultado estruturado com o preço e a periodicidade cadastrados, ou com a indicação de ausência

#### Scenario: Texto do modelo diverge do resultado
- **WHEN** o modelo simulado devolve prosa diferente dos dados de preço ou afirma uma reserva sem sucesso da operação
- **THEN** os resultados oficiais permanecem iguais aos dados do backend e nenhuma alteração de cadastro, disponibilidade ou estado de reserva é inferida desse texto

#### Scenario: Saudação sem consulta
- **WHEN** o usuário cumprimenta o assistente ou responde a uma pergunta sobre seu objetivo
- **THEN** o sistema pode responder sem ferramenta, sem preencher resultados comerciais a partir dessa prosa

### Requirement: Tool calling e regras de negócio separadas

Pedidos de consulta SHALL ser executados por tool calling real, e os resultados SHALL ser associados às chamadas correspondentes pela associação padrão da integração. Ferramentas SHALL delegar consultas e gravações a operações determinísticas, acessando dados por interfaces de repositório. Interpretação de interesse pode usar a LLM, mas validação de curso, existência de lead, autorização de reserva e disponibilidade MUST permanecer no backend.

#### Scenario: Consulta de horários
- **WHEN** o usuário seleciona um curso e pergunta sobre aula experimental
- **THEN** `get_available_slots` consulta os horários desse curso e fornece dados estruturados para a resposta

#### Scenario: Falta informação para a próxima ação
- **WHEN** o curso ou os dados de contato ainda não estão definidos
- **THEN** o assistente pede o complemento, sem fabricar identificadores ou executar escrita com dados incompletos

### Requirement: Escrita proposta não equivale a escrita autorizada

Uma chamada de `create_lead` ou `schedule_trial_class` produzida pelo modelo SHALL preparar uma ação pendente quando a operação requer confirmação, sem executar a gravação. O resultado esperado nesse caso SHALL ser `CONFIRMATION_REQUIRED`, acompanhado da ação pendente na resposta do chat. Somente uma confirmação explícita recebida e vinculada pelo backend SHALL permitir executar os argumentos armazenados dessa ação. Para cadastro, essa exigência é a política de UX da versão; para reserva, é uma regra obrigatória de negócio.

O sistema MUST NOT aceitar `confirmed: true`, alegação textual de confirmação ou argumentos de autorização gerados pela LLM como autorização de reserva. A confirmação do cadastro MUST NOT autorizar automaticamente uma reserva.

#### Scenario: Modelo tenta autorizar uma reserva
- **WHEN** uma tool call de reserva inclui `confirmed: true` ou o modelo afirma que o usuário confirmou
- **THEN** nenhum agendamento é realizado com base nessa alegação; campo extra é rejeitado e a autorização continua dependente da ação pendente no backend

#### Scenario: Usuário confirma a ação apresentada
- **WHEN** o canal de confirmação recebe a ação pendente válida vinculada à conversa
- **THEN** o backend executa os argumentos que o usuário revisou, sem solicitar à LLM que os reconstrua

### Requirement: Resultados de escrita sobrevivem a falhas de redação

Depois de uma gravação bem-sucedida, o sistema SHALL registrar seu resultado antes de solicitar texto final à LLM. Uma falha posterior do modelo MUST NOT apagar o resultado ou transformar sucesso em indicação de que nada foi gravado. O chat SHALL receber o resultado oficial e uma mensagem de contingência produzida pelo backend. Uma repetição da confirmação SHALL recuperar o resultado existente, conforme as regras da operação, sem nova gravação.

#### Scenario: Falha da LLM após reserva
- **WHEN** a reserva foi registrada e a redação final falha
- **THEN** o sistema retorna o recibo da reserva e uma mensagem de confirmação baseada nele, mantendo a vaga ocupada

#### Scenario: Falha antes da escrita
- **WHEN** a ferramenta não consegue executar a operação
- **THEN** o sistema informa falha sem emitir recibo de sucesso ou preencher os dados ausentes com conteúdo do modelo

### Requirement: Testes essenciais independentes de serviços externos

Schemas, operações de negócio, preparação e confirmação de ações, encaminhamento de resultados e atualização de contexto MUST ser verificáveis com repositórios em memória e modelo simulado, sem rede, credenciais de LLM ou calendário real. A suíte SHALL verificar a origem dos dados e as instruções do agente, sem apresentar esses testes como prova de infalibilidade da linguagem natural.

#### Scenario: Jornada simulada
- **WHEN** os testes executam catálogo, cadastro e reserva com dados fixos e modelo simulado
- **THEN** validam resultados, autorização, disponibilidade e isolamento sem chamadas externas
