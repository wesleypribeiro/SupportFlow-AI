import type { ToolCall } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createLeadInputSchema } from '@supportflow/contracts/language-school';
import type { ToolExecutionScope } from '../../../core/chat.js';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { createCatalogTools } from './catalog-tools.js';
import { contentAndArtifact, createLangChainCatalogTools, executeLanguageSchoolTool } from './langchain-catalog-tools.js';
import { createLeadTool } from './lead-tool.js';

export function createLangChainSchoolTools(catalogTools: ReturnType<typeof createCatalogTools>, repositories: {
  schoolRepository: SchoolRepository;
  leadRepository: LeadRepository;
}) {
  const catalog = createLangChainCatalogTools(catalogTools);

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

  return {
    tools: [...catalog.tools, leadAdapter()],
    execute: (call: ToolCall, scope: ToolExecutionScope<ConversationContext>) =>
      call.name === 'create_lead'
        ? executeLanguageSchoolTool([leadAdapter(scope)], call, 'Entrada inválida para o cadastro.')
        : catalog.execute(call),
  };
}
