# WhatsApp Delivery

## Purpose

Entregar apresentação textual de fatos e operações oficiais pelo WhatsApp, distinguindo resultados comerciais de aceite, entrega e recuperação do transporte.

## ADDED Requirements

### Requirement: Apresentar as sete ferramentas a partir dos contratos oficiais

O canal SHALL apresentar escola, cursos, detalhes, horários, lead, reserva e protocolo através dos results existentes e validados. Preço null e zero SHALL permanecer distintos; horários SHALL usar data/hora/fuso oficiais; listas vazias SHALL ser informadas sem invenção. A apresentação oficial MUST NOT extrair preço, protocolo, estado de operação ou argumentos da prosa. Diálogo sem resultados/prévia poderá usar reply; apresentação comercial SHALL ser determinística, sem criar outro contrato de negócio.

#### Scenario: Preço divergente na prosa
- **WHEN** reply menciona R$ 999 e o resultado oficial contém 35000 centavos
- **THEN** a apresentação de preço usa R$ 350,00 com a periodicidade cadastrada

#### Scenario: Ausência e zero
- **WHEN** os resultados trazem price null, preço zero ou slots vazios
- **THEN** o canal informa respectivamente preço indisponível, zero real ou ausência de horários, sem estimar valores

#### Scenario: Recibo contradiz a prosa
- **WHEN** reply afirma falha mas o result contém created com booking oficial
- **THEN** a apresentação confirma a operação registrada com os dados do recibo

### Requirement: Enviar pelo adapter oficial sem expor credenciais

O transporte SHALL enviar texto e botões pela Cloud API com destinatário resolvido pelo backend e versão explícita. Segredos e configuração MUST NOT vir de mensagens/LLM/frontend. HTTP de sucesso com ID válido SHALL significar accepted, nunca delivered. Timeout, erro de conexão ou resposta não validável após possível aceite SHALL ser indeterminação, sem sucesso inventado. Mensagens longas SHALL preservar dados em partes identificáveis e limites suportados.

#### Scenario: Aceite do provedor
- **WHEN** a Meta aceita o envio e devolve um ID válido
- **THEN** o envio fica accepted e só evidência posterior poderá registrar delivered/read

#### Scenario: Resposta HTTP perdida
- **WHEN** o cliente não sabe se o envio foi aceito
- **THEN** o estado fica unknown e nenhuma nova escrita de negócio é disparada para descobrir o resultado

#### Scenario: Conteúdo longo
- **WHEN** catálogo ou recibos excedem o limite de uma mensagem textual
- **THEN** partes preservam todos os fatos, sem cortar valores ou habilitar confirmação sobre prévia incompleta

### Requirement: Usar somente oferta efetivamente apresentada para aceitar handoff

Uma aceitação curta de atendimento humano SHALL corresponder a oferta anterior realmente apresentada no canal. Texto apenas gerado, omitido pelo apresentador ou sem evidência de entrega MUST NOT autorizar handoff. O backend SHALL fornecer essa evidência ao reconhecimento de intenção existente sem aceitar texto de oferta inventado pelo webhook. Pedido explícito SHALL continuar dispensando oferta e cadastro.

#### Scenario: Oferta não foi enviada
- **WHEN** o histórico do modelo contém oferta mas sua apresentação foi omitida ou falhou, e o visitante escreve “sim”
- **THEN** nenhuma solicitação é registrada com base apenas nessa oferta não apresentada

#### Scenario: Oferta entregue ou resposta correlacionada
- **WHEN** há evidência de entrega/leitura da última oferta ou resposta explicitamente vinculada à mensagem aceita que a contém
- **THEN** a aceitação pode ser validada pelo backend, sem confirmar cadastro ou reserva

### Requirement: Separar confirmação de entrega de confirmação comercial

Status SHALL ser correlacionados a envios da origem/destinatário corretos. Duplicatas ou chegada fora de ordem MUST NOT regredir evidência de entrega/leitura, criar conversa ou executar negócio. Um status anterior ao retorno HTTP poderá ser conciliado somente após comprovar o vínculo do envio. Falha de entrega MUST NOT cancelar cadastro/reserva ou mudar requested do handoff.

#### Scenario: Leitura antes de status de envio
- **WHEN** read é recebido e depois chega sent atrasado do mesmo envio
- **THEN** a evidência de leitura permanece e nenhum turno é criado

#### Scenario: Status sem vínculo ou de outro destinatário
- **WHEN** o evento não corresponde a um envio conhecido e compatível
- **THEN** não altera estado comercial ou entrega de outra conversa

#### Scenario: Falha de entrega depois da reserva
- **WHEN** um recibo de reserva foi registrado e o provedor reporta failed
- **THEN** a reserva permanece confirmada; somente a apresentação necessita recuperação

### Requirement: Recuperar transporte sem repetir decisões ou escritas

Resultado oficial e estado de processamento SHALL ser guardados antes de formatar/enviar. Não haverá retry automático de envio neste MVP. O comando explícito `/reenviar` SHALL recuperar a última resposta elegível da própria conversa sem executar modelo/tools ou gerar nova autorização. Partes aceitas não serão automaticamente reenviadas; parte unknown poderá duplicar apresentação, limitação que SHALL ser documentada. Sem estado local, MUST NOT inventar resposta ou recibo.

#### Scenario: Reserva gravada e envio falha
- **WHEN** o visitante pede `/reenviar` após falha de transporte do recibo created
- **THEN** recebe o mesmo resultado/booking, sem chamada adicional de reserva ou redação

#### Scenario: Prévia antiga aguardava reenvio
- **WHEN** a ação foi substituída antes de recuperar o envio
- **THEN** o canal não reapresenta botão confirmável da ação anterior e orienta revisão atual

#### Scenario: Recuperação sem registro
- **WHEN** não existe resposta recuperável, inclusive após reinício
- **THEN** o canal informa a limitação sem reconstruir resultados a partir do texto do visitante

### Requirement: Respeitar janela sem iniciar mensagens ativas

Envios livres e botões SHALL ocorrer somente dentro da janela de 24 horas da última mensagem elegível do visitante. Timestamp original SHALL orientar a janela; duplicata, status e mensagem de saída MUST NOT reabri-la. Cada tentativa SHALL verificar a janela novamente. Fora dela, o canal SHALL bloquear envio e aguardar nova mensagem; templates, campanhas e follow-up automático ficam fora deste MVP.

#### Scenario: Janela expira antes do envio
- **WHEN** o processamento termina ou o reenvio é solicitado fora da janela elegível
- **THEN** a resposta permanece local, sem envio livre ou template improvisado

#### Scenario: Reentrega antiga e nova mensagem
- **WHEN** um webhook antigo é repetido e depois chega texto novo válido do visitante
- **THEN** somente a nova mensagem pode renovar a janela, permitindo recuperar resultado ainda em memória

### Requirement: Preservar contingência após escrita e handoff local

Falha exclusiva de redação após escrita SHALL manter resultado oficial e mensagem de contingência do backend. O canal SHALL entregar esse resultado sem pedir que a LLM reconstrua sucesso. Handoff SHALL exibir protocolo/motivo originais e requested como solicitado localmente, sem botão de confirmação, promessa de prazo ou afirmação de atendimento iniciado.

#### Scenario: Modelo falha depois de confirmar aula
- **WHEN** a reserva está salva e a redação falha
- **THEN** o canal envia o recibo oficial e contingência; retries preservam o mesmo resultado histórico

#### Scenario: Solicitação humana sem cadastro
- **WHEN** o visitante pede uma pessoa sem possuir lead e a tool registra o pedido
- **THEN** o protocolo oficial é apresentado como solicitação demonstrativa, sem criar lead ou confirmar ação pendente

#### Scenario: Repetição do pedido humano
- **WHEN** a mesma conversa pede atendimento novamente com outro motivo
- **THEN** protocolo e motivo originais permanecem na apresentação
