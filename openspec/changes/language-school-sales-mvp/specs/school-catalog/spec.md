# School Catalog

## Purpose

Disponibilizar informações estruturadas da escola, dos cursos e dos preços para apoiar o atendimento comercial sem usar o conhecimento próprio do modelo como fonte desses fatos.

## ADDED Requirements

### Requirement: Consultar informações cadastradas da escola

O sistema SHALL disponibilizar `get_school_info({})` para consultar a única escola configurada no MVP. Os dados retornados SHALL incluir nome, descrição, endereço, contato, horário de funcionamento e fuso cadastrados. A fonte dessas informações SHALL ser exclusivamente os dados estruturados do backend; o agente MUST NOT ser instruído a preenchê-las a partir de conhecimento próprio. As informações demonstrativas SHALL usar dados fictícios.

#### Scenario: Responder uma dúvida sobre a escola
- **WHEN** o visitante pergunta onde a escola fica ou como entrar em contato
- **THEN** o sistema consulta `get_school_info({})` e usa os dados retornados como fonte das informações apresentadas

### Requirement: Oferecer somente cursos ativos do catálogo

O sistema SHALL disponibilizar `get_courses({})` para listar os cursos ativos cadastrados, com identificador, nome, idioma, modalidade e indicador de atividade. O sistema MUST NOT oferecer cursos ausentes ou inativos como opções comerciais disponíveis.

#### Scenario: Consultar cursos disponíveis
- **WHEN** o catálogo contém cursos ativos e inativos e o visitante pergunta quais cursos existem
- **THEN** a consulta retorna somente os cursos ativos com seus identificadores e informações cadastradas

#### Scenario: Catálogo sem cursos ativos
- **WHEN** não há cursos ativos cadastrados
- **THEN** a consulta retorna uma lista vazia e o sistema informa que não há cursos disponíveis no catálogo consultado

### Requirement: Consultar detalhes e preços sem inferir dados ausentes

O sistema SHALL disponibilizar `get_course_details({ courseId })` para obter identificador, nome, descrição, idioma, modalidade, indicador de atividade e preço de um curso ativo. O preço SHALL ser `null` quando não cadastrado ou um objeto com `amountCents` inteiro não negativo, `currency: "BRL"` e `billingPeriod` igual a `"month"` ou `"course"`. Os dados estruturados oficiais e sua apresentação SHALL preservar valor, moeda e periodicidade cadastrados; preço ausente MUST NOT ser convertido pelo sistema em zero, gratuidade, desconto ou valor estimado. Curso inexistente ou inativo SHALL resultar em `NOT_FOUND`.

#### Scenario: Preço cadastrado com periodicidade
- **WHEN** o visitante consulta um curso com preço de `35000` centavos, moeda `BRL` e periodicidade `month`
- **THEN** o resultado estruturado preserva esses dados e sua apresentação oficial corresponde a R$ 350,00 por mês

#### Scenario: Preço não informado
- **WHEN** o curso existe e seu preço está cadastrado como `null`
- **THEN** o resultado e a apresentação oficiais indicam preço indisponível, sem preencher um valor substituto a partir da LLM

#### Scenario: Curso inexistente ou inativo
- **WHEN** `get_course_details` recebe o identificador de um curso inexistente ou inativo
- **THEN** retorna `NOT_FOUND` sem apresentar esse curso como opção disponível

### Requirement: Validar contratos de consulta do catálogo

As três ferramentas de catálogo SHALL aceitar somente os campos previstos em seus contratos e retornar resultados validados por schemas estritos. `get_school_info` e `get_courses` SHALL exigir objeto vazio; `get_course_details` SHALL exigir apenas `courseId` textual não vazio. Entrada inválida SHALL resultar em `INVALID_INPUT` antes da consulta. Falha inesperada ou saída inválida SHALL resultar em `OPERATION_FAILED`, sem substituir dados por conteúdo gerado pelo modelo.

#### Scenario: Campos não previstos na consulta
- **WHEN** uma chamada de catálogo inclui campos adicionais ou `get_course_details` omite `courseId`
- **THEN** o sistema retorna `INVALID_INPUT` antes de consultar os dados
