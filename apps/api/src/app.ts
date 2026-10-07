import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { loadWhatsAppConfig } from './channels/whatsapp/config.js';
import { InMemoryWhatsAppConfirmationReferences } from './channels/whatsapp/confirmation-references.js';
import { InMemoryWhatsAppConversationBindings } from './channels/whatsapp/conversation-bindings.js';
import { WhatsAppDemoSessionPolicy } from './channels/whatsapp/demo-session.js';
import { InMemoryWhatsAppInbox } from './channels/whatsapp/inbox.js';
import type { WhatsAppInboxOptions, WhatsAppInboxProcessor } from './channels/whatsapp/inbox.js';
import { registerMetaWebhookRoutes } from './channels/whatsapp/meta/webhook-route.js';
import { createMetaCloudApiClient } from './channels/whatsapp/meta/cloud-api-client.js';
import { createWhatsAppTextChannel } from './channels/whatsapp/text-channel.js';
import type { WhatsAppTransport } from './channels/whatsapp/transport.js';
import { createLeadResultSchema, languageSchoolChatResponseSchema, scheduleTrialClassResultSchema, transferToHumanResultSchema } from '@supportflow/contracts/language-school';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import { registerChatRoute } from './core/chat-route.js';
import { createChatRunner } from './core/chat.js';
import { createConversationService } from './core/conversation-service.js';
import { loadCoreConfig } from './core/config.js';
import { InMemoryConversations } from './core/conversations.js';
import type { ActionExecutor } from './core/pending-actions.js';
import { createServer } from './core/server.js';
import { loadLanguageSchoolConfig } from './modules/language-school/config.js';
import { createConversationContext } from './modules/language-school/domain/conversation-context.js';
import { courseFixtures, schoolFixture } from './modules/language-school/infrastructure/catalog-fixtures.js';
import { createCatalogTools } from './modules/language-school/infrastructure/catalog-tools.js';
import { InMemorySchoolRepository } from './modules/language-school/infrastructure/in-memory-school-repository.js';
import { createLangChainSchoolTools } from './modules/language-school/infrastructure/langchain-tools.js';
import { createContextUpdater, describeConversationContext } from './modules/language-school/infrastructure/langchain-context.js';
import { languageSchoolInstructions } from './modules/language-school/prompt.js';
import { createLanguageSchoolPendingActions } from './modules/language-school/infrastructure/pending-actions.js';
import type { LanguageSchoolAction } from './modules/language-school/infrastructure/pending-actions.js';
import type { LeadRepository } from './modules/language-school/domain/lead-repository.js';
import type { SchoolRepository } from './modules/language-school/domain/school-repository.js';
import { InMemoryLeadRepository } from './modules/language-school/infrastructure/in-memory-lead-repository.js';
import { createLeadTool } from './modules/language-school/infrastructure/lead-tool.js';
import { createLanguageSchoolConfirmationExecutor } from './modules/language-school/infrastructure/action-confirmation.js';
import { leadFailure } from './modules/language-school/application/create-lead.js';
import type { TrialClassRepository } from './modules/language-school/domain/trial-class-repository.js';
import { InMemoryTrialClassRepository } from './modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from './modules/language-school/infrastructure/slot-fixtures.js';
import { createAvailableSlotsTool } from './modules/language-school/infrastructure/available-slots-tool.js';
import { createScheduleTrialClassTool } from './modules/language-school/infrastructure/trial-class-tool.js';
import { trialClassFailure } from './modules/language-school/application/prepare-trial-class.js';
import { createConfirmationReply } from './modules/language-school/infrastructure/confirmation-reply.js';
import type { HandoffRepository } from './modules/language-school/domain/handoff-repository.js';
import { InMemoryHandoffRepository } from './modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { createTransferToHumanTool } from './modules/language-school/infrastructure/handoff-tool.js';
import { handoffFailure } from './modules/language-school/application/transfer-to-human.js';
import type { HandoffScope } from './modules/language-school/application/transfer-to-human.js';
import { describeHandoffResults } from './modules/language-school/infrastructure/handoff-reply.js';
import { presentLanguageSchoolWhatsApp } from './modules/language-school/infrastructure/whatsapp-presentation.js';

// Composição explícita: o core não importa nem escolhe o segmento da aplicação.
export function createApplication(environment: NodeJS.ProcessEnv, options: {
  model?: BaseChatModel;
  executeAction?: ActionExecutor<LanguageSchoolAction>;
  schoolRepository?: SchoolRepository;
  leadRepository?: LeadRepository;
  trialClassRepository?: TrialClassRepository;
  handoffRepository?: HandoffRepository;
  now?: () => Date;
  // null permite compor somente recepção/sessão nos testes dessas fronteiras.
  whatsappProcessor?: WhatsAppInboxProcessor<LanguageSchoolChatResponse> | null;
  whatsappTransport?: WhatsAppTransport;
  whatsappNow?: () => Date;
  whatsappInboxLimits?: WhatsAppInboxOptions['limits'];
  whatsappOnNotice?: WhatsAppInboxOptions['onNotice'];
} = {}) {
  const config = {
    ...loadCoreConfig(environment),
    school: loadLanguageSchoolConfig(environment),
    whatsapp: loadWhatsAppConfig(environment),
  };

  if (config.school.schoolId !== schoolFixture.id) {
    throw new Error('SCHOOL_ID não corresponde à escola cadastrada nesta demonstração.');
  }

  const schoolRepository = options.schoolRepository ?? new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const leadRepository = options.leadRepository ?? new InMemoryLeadRepository();
  const trialClassRepository = options.trialClassRepository ?? new InMemoryTrialClassRepository(slotFixtures);
  const handoffRepository = options.handoffRepository ?? new InMemoryHandoffRepository();
  const transferToHuman = createTransferToHumanTool(handoffRepository);
  const now = options.now ?? (() => new Date());
  const getAvailableSlots = createAvailableSlotsTool({
    schoolRepository, trialClassRepository, now,
  });
  const catalogTools = createCatalogTools(schoolRepository);
  const langChainTools = createLangChainSchoolTools(catalogTools, { schoolRepository, leadRepository, trialClassRepository, handoffRepository, now });
  const model = options.model ?? (config.llm
    ? new ChatOpenAI({ apiKey: config.llm.apiKey, model: config.llm.model })
    : null);
  const server = createServer();
  const conversations = new InMemoryConversations(createConversationContext);
  const actions = createLanguageSchoolPendingActions();
  const scheduleTrialClass = createScheduleTrialClassTool({
    schoolRepository, leadRepository, trialClassRepository, now,
    prepareAction: (scope, preview) => {
      actions.prepare(scope.conversationId, scope.context.revision, { kind: 'schedule_trial_class', preview });
    },
    clearPendingAction: (scope) => { actions.invalidateCurrent(scope.conversationId); },
  });
  const createLead = createLeadTool({
    schoolRepository, leadRepository,
    prepareAction: (scope, preview) => {
      actions.prepare(scope.conversationId, scope.context.revision, { kind: 'create_lead', preview });
    },
    clearPendingAction: (scope) => { actions.invalidateCurrent(scope.conversationId); },
  });
  const conversationService = createConversationService({
    conversations,
    actions,
    executeAction: options.executeAction ?? createLanguageSchoolConfirmationExecutor({ schoolRepository, leadRepository, trialClassRepository, now, conversations }),
    describeReceipt: createConfirmationReply(model),
    runTurn: createChatRunner({
      model,
      instructions: languageSchoolInstructions,
      tools: langChainTools.tools,
      executeTool: langChainTools.execute,
      updateContext: createContextUpdater(model, schoolRepository, { trialClassRepository, now }),
      describeContext: describeConversationContext,
      describeResults: describeHandoffResults,
    }),
    parseResponse: (response) => languageSchoolChatResponseSchema.parse(response),
  });
  registerChatRoute(server, conversationService);
  const whatsappBindings = config.whatsapp.enabled
    ? new InMemoryWhatsAppConversationBindings(conversationService)
    : undefined;
  const whatsappConfirmationReferences = whatsappBindings
    ? new InMemoryWhatsAppConfirmationReferences(whatsappBindings)
    : undefined;
  const whatsappText = config.whatsapp.enabled && whatsappBindings && whatsappConfirmationReferences && options.whatsappProcessor !== null
    ? createWhatsAppTextChannel({
      service: conversationService,
      bindings: whatsappBindings,
      references: whatsappConfirmationReferences,
      present: presentLanguageSchoolWhatsApp,
      transport: options.whatsappTransport ?? createMetaCloudApiClient(config.whatsapp, { fetch }),
      now: options.whatsappNow ?? now,
    })
    : undefined;
  const whatsappOnNotice: WhatsAppInboxOptions['onNotice'] = options.whatsappOnNotice ?? (whatsappText
    ? (event, notice) => whatsappText.outbox.sendNotice(event, notice.body)
    : undefined);
  const whatsappInbox = whatsappBindings
    ? new InMemoryWhatsAppInbox(options.whatsappProcessor ?? whatsappText?.process, {
      now: options.whatsappNow ?? now,
      sessions: new WhatsAppDemoSessionPolicy(whatsappBindings),
      ...(options.whatsappInboxLimits && { limits: options.whatsappInboxLimits }),
      ...(whatsappOnNotice && { onNotice: whatsappOnNotice }),
      ...(whatsappText && { onProcessed: whatsappText.present }),
    })
    : undefined;
  if (config.whatsapp.enabled) {
    const recipients = config.whatsapp.demoRecipients;
    registerMetaWebhookRoutes(server, {
      appSecret: config.whatsapp.appSecret,
      webhookVerifyToken: config.whatsapp.webhookVerifyToken,
      wabaId: config.whatsapp.wabaId,
      phoneNumberId: config.whatsapp.phoneNumberId,
    }, { admit: (event) => recipients.includes(event.senderId) ? whatsappInbox!.admit(event) : 'accepted' },
    (event) => whatsappText?.outbox.receiveStatus(event));
  }

  // Ponto interno de composição; argumentos não vêm do navegador.
  const prepareAction = (conversationId: string, proposal: unknown) => conversations.runExclusive(conversationId, () => {
    const conversation = conversations.get(conversationId);
    if (!conversation) throw new Error('Conversa não encontrada para preparar ação.');
    return actions.prepare(conversationId, conversation.context.revision, proposal);
  });

  // Acesso determinístico direto sob a mesma fila, útil sem o modelo.
  const prepareLead = (conversationId: string, input: unknown) => conversations.runExclusive(conversationId, async () => {
    const conversation = conversations.get(conversationId);
    if (!conversation) return { result: createLeadResultSchema.parse(leadFailure('NOT_FOUND')), pendingAction: null };
    const result = await createLead(input, { conversationId, context: conversation.context });
    return { result, pendingAction: actions.pending(conversationId, conversation.context.revision) };
  });

  // Proposta direta sob a fila da conversa, independente do agente e sem executar reserva.
  const prepareTrialClass = (conversationId: string, input: unknown) => conversations.runExclusive(conversationId, async () => {
    const conversation = conversations.get(conversationId);
    if (!conversation) return { result: scheduleTrialClassResultSchema.parse(trialClassFailure('NOT_FOUND')), pendingAction: null };
    const result = await scheduleTrialClass(input, { conversationId, context: conversation.context });
    return { result, pendingAction: actions.pending(conversationId, conversation.context.revision) };
  });

  // Acesso interno, sem endpoint novo ou LLM. O chamador fornece a intenção já
  // identificada do visitante; não existe segunda confirmação para este registro.
  const requestHumanHandoff = (conversationId: string, input: unknown, visitorIntent: HandoffScope['visitorIntent']) =>
    conversations.runExclusive(conversationId, async () => {
      if (!conversations.get(conversationId)) return transferToHumanResultSchema.parse(handoffFailure('OPERATION_FAILED'));
      return transferToHuman(input, { conversationId, visitorIntent });
    });

  return { server, config, catalogTools, conversations, conversationService, whatsappBindings, whatsappConfirmationReferences, whatsappInbox, whatsappOutbox: whatsappText?.outbox, prepareAction, prepareLead, prepareTrialClass, getAvailableSlots, requestHumanHandoff };
}
