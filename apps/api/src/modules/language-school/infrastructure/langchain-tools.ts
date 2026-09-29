import { AIMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createLeadInputSchema, getAvailableSlotsInputSchema, scheduleTrialClassInputSchema, transferToHumanInputSchema } from '@supportflow/contracts/language-school';
import type { ToolExecutionScope } from '../../../core/chat.js';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { createCatalogTools } from './catalog-tools.js';
import { contentAndArtifact, createLangChainCatalogTools, executeLanguageSchoolTool } from './langchain-catalog-tools.js';
import { createLeadTool } from './lead-tool.js';
import type { TrialClassRepository } from '../domain/trial-class-repository.js';
import { createAvailableSlotsTool } from './available-slots-tool.js';
import { createScheduleTrialClassTool } from './trial-class-tool.js';
import { trialClassFailure } from '../application/prepare-trial-class.js';
import type { HandoffRepository } from '../domain/handoff-repository.js';
import { resolveHandoffIntent } from '../domain/handoff-intent.js';
import { createTransferToHumanTool } from './handoff-tool.js';

export function createLangChainSchoolTools(catalogTools: ReturnType<typeof createCatalogTools>, repositories: {
  schoolRepository: SchoolRepository;
  leadRepository: LeadRepository;
  trialClassRepository: TrialClassRepository;
  handoffRepository: HandoffRepository;
  now: () => Date;
}) {
  const catalog = createLangChainCatalogTools(catalogTools);
  const available = createAvailableSlotsTool(repositories);
  const slotsAdapter = tool(async (input) => contentAndArtifact({ tool: 'get_available_slots', result: await available(input) }), {
    name: 'get_available_slots', schema: getAvailableSlotsInputSchema, responseFormat: 'content_and_artifact',
    description: 'Consulta horários futuros e livres cadastrados para um curso ativo. Não seleciona nem reserva uma vaga.',
  });

  // A declaração enviada ao modelo contém somente o schema público. A closure
  // de execução recebe o escopo validado do turno, nunca argumentos da LLM.
  function leadAdapter(scope?: ToolExecutionScope<ConversationContext>) {
    return tool(async (input) => {
      if (!scope) throw new Error('Escopo de execução ausente.');
      const createLead = createLeadTool({
        ...repositories,
        prepareAction: (_scope, preview) => scope.proposeAction({ kind: 'create_lead', preview }),
        clearPendingAction: () => scope.proposeAction(null),
      });
      return contentAndArtifact({ tool: 'create_lead', result: await createLead(input, scope) });
    }, {
      name: 'create_lead',
      description: 'Registra ou atualiza o interesse usando os dados vigentes já validados no contexto. Quando exige escrita, apenas PREPARA uma prévia para confirmação; esta chamada não é consentimento e não grava. Dados idênticos já registrados retornam existing.',
      schema: createLeadInputSchema,
      responseFormat: 'content_and_artifact',
    });
  }

  function scheduleAdapter(scope?: ToolExecutionScope<ConversationContext>) {
    return tool(async (input) => {
      if (!scope) throw new Error('Escopo de execução ausente.');
      const schedule = createScheduleTrialClassTool({
        ...repositories,
        prepareAction: (_scope, preview) => scope.proposeAction({ kind: 'schedule_trial_class', preview }),
        clearPendingAction: () => scope.proposeAction(null),
      });
      return contentAndArtifact({ tool: 'schedule_trial_class', result: scope.context.slotId === null
        ? trialClassFailure('INVALID_INPUT') : await schedule(input, scope) });
    }, {
      name: 'schedule_trial_class', schema: scheduleTrialClassInputSchema, responseFormat: 'content_and_artifact',
      description: 'Propõe aula para leadId oficial atualizado e slotId vigente do contexto. Somente PREPARA confirmação específica; não ocupa vaga nem representa consentimento. Mesma reserva já concluída retorna existing.',
    });
  }

  function handoffAdapter(scope?: ToolExecutionScope<ConversationContext>) {
    return tool(async (input) => {
      if (!scope) throw new Error('Escopo de execução ausente.');
      // Apenas a última resposta concluída do servidor pode conter uma oferta.
      // Mensagens de tools, prosa desta seleção e histórico enviado pelo cliente
      // não autorizam o registro.
      const previous = scope.history.at(-1);
      const previousReply = previous && AIMessage.isInstance(previous) && !previous.tool_calls?.length
        && typeof previous.content === 'string' ? previous.content : null;
      const visitorIntent = resolveHandoffIntent(scope.message, previousReply);
      const result = await createTransferToHumanTool(repositories.handoffRepository)(input, {
        conversationId: scope.conversationId, visitorIntent,
      });
      return contentAndArtifact({ tool: 'transfer_to_human', result });
    }, {
      name: 'transfer_to_human', schema: transferToHumanInputSchema, responseFormat: 'content_and_artifact',
      description: 'Registra solicitação LOCAL demonstrativa de atendimento humano após pedido explícito ou aceitação da última oferta. Não exige cadastro nem segunda confirmação. Não inicia atendimento ao vivo ou envio externo; repetição devolve o protocolo e motivo originais.',
    });
  }

  return {
    tools: [...catalog.tools, slotsAdapter, leadAdapter(), scheduleAdapter(), handoffAdapter()],
    execute: (call: ToolCall, scope: ToolExecutionScope<ConversationContext>) => {
      if (call.name === 'transfer_to_human') return executeLanguageSchoolTool([handoffAdapter(scope)], call, 'Informe somente um motivo válido para a solicitação.', true);
      if (call.name === 'create_lead') return executeLanguageSchoolTool([leadAdapter(scope)], call, 'Entrada inválida para o cadastro.');
      if (call.name === 'get_available_slots') return executeLanguageSchoolTool([slotsAdapter], call, 'Entrada inválida para horários.');
      if (call.name === 'schedule_trial_class') return executeLanguageSchoolTool([scheduleAdapter(scope)], call, 'Entrada inválida para a aula experimental.');
      return catalog.execute(call);
    },
  };
}
