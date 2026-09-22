import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { registerChatRoute } from './core/chat-route.js';
import { createChatRunner } from './core/chat.js';
import { loadCoreConfig } from './core/config.js';
import { InMemoryConversations } from './core/conversations.js';
import { createServer } from './core/server.js';
import { loadLanguageSchoolConfig } from './modules/language-school/config.js';
import { createConversationContext } from './modules/language-school/domain/conversation-context.js';
import { courseFixtures, schoolFixture } from './modules/language-school/infrastructure/catalog-fixtures.js';
import { createCatalogTools } from './modules/language-school/infrastructure/catalog-tools.js';
import { InMemorySchoolRepository } from './modules/language-school/infrastructure/in-memory-school-repository.js';
import { createLangChainCatalogTools } from './modules/language-school/infrastructure/langchain-catalog-tools.js';
import { createContextUpdater, describeConversationContext } from './modules/language-school/infrastructure/langchain-context.js';
import { languageSchoolInstructions } from './modules/language-school/prompt.js';

// Composição explícita: o core não importa nem escolhe o segmento da aplicação.
export function createApplication(environment: NodeJS.ProcessEnv, options: { model?: BaseChatModel } = {}) {
  const config = {
    ...loadCoreConfig(environment),
    school: loadLanguageSchoolConfig(environment),
  };

  if (config.school.schoolId !== schoolFixture.id) {
    throw new Error('SCHOOL_ID não corresponde à escola cadastrada nesta demonstração.');
  }

  const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const catalogTools = createCatalogTools(schoolRepository);
  const langChainCatalog = createLangChainCatalogTools(catalogTools);
  const model = options.model ?? (config.llm
    ? new ChatOpenAI({ apiKey: config.llm.apiKey, model: config.llm.model })
    : null);
  const server = createServer();
  registerChatRoute(server, {
    conversations: new InMemoryConversations(createConversationContext),
    runTurn: createChatRunner({
      model,
      instructions: languageSchoolInstructions,
      tools: langChainCatalog.tools,
      executeTool: langChainCatalog.execute,
      updateContext: createContextUpdater(model, schoolRepository),
      describeContext: describeConversationContext,
    }),
    parseResponse: (response) => languageSchoolChatResponseSchema.parse(response),
  });

  return { server, config, catalogTools };
}
