import { ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages';
import { tool, ToolInputParsingException } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  getCourseDetailsInputSchema,
  getCoursesInputSchema,
  getSchoolInfoInputSchema,
  languageSchoolToolResultSchema,
  toolFailureSchema,
} from '@supportflow/contracts/language-school';
import type { LanguageSchoolToolResult } from '@supportflow/contracts/language-school';
import type { createCatalogTools } from './catalog-tools.js';

const executionError = 'Não foi possível executar a consulta do atendimento.';

function contentAndArtifact(result: LanguageSchoolToolResult): [string, LanguageSchoolToolResult] {
  const validated = languageSchoolToolResultSchema.parse(result);
  return [JSON.stringify(validated), validated];
}

export function createLangChainCatalogTools(catalogTools: ReturnType<typeof createCatalogTools>) {
  const tools = [
    tool(async (input) => contentAndArtifact({
      tool: 'get_school_info',
      result: await catalogTools.get_school_info(input),
    }), {
      name: 'get_school_info',
      description: 'Consulta os dados registrados da escola, contato e funcionamento.',
      schema: getSchoolInfoInputSchema,
      responseFormat: 'content_and_artifact',
    }),
    tool(async (input) => contentAndArtifact({
      tool: 'get_courses',
      result: await catalogTools.get_courses(input),
    }), {
      name: 'get_courses',
      description: 'Lista os cursos ativos e seus identificadores para consultar detalhes.',
      schema: getCoursesInputSchema,
      responseFormat: 'content_and_artifact',
    }),
    tool(async (input) => contentAndArtifact({
      tool: 'get_course_details',
      result: await catalogTools.get_course_details(input),
    }), {
      name: 'get_course_details',
      description: 'Consulta detalhes e preço cadastrado de um curso ativo pelo courseId.',
      schema: getCourseDetailsInputSchema,
      responseFormat: 'content_and_artifact',
    }),
  ];

  async function execute(call: ToolCall): Promise<{
    message: ToolMessage;
    result: LanguageSchoolToolResult;
  }> {
    const selected: StructuredToolInterface | undefined = tools.find(
      (candidate) => candidate.name === call.name,
    );
    if (!selected || !call.id?.trim()) {
      throw new Error(executionError);
    }

    let message: ToolMessage;
    try {
      const output = await selected.invoke({ ...call, type: 'tool_call' });
      if (!ToolMessage.isInstance(output)) {
        throw new Error(executionError);
      }
      message = output;
    } catch (error) {
      if (!(error instanceof ToolInputParsingException)) {
        throw new Error(executionError);
      }

      const result = languageSchoolToolResultSchema.parse({
        tool: selected.name,
        result: toolFailureSchema.parse({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Entrada inválida para a consulta de catálogo.' },
        }),
      });
      message = new ToolMessage({
        name: selected.name,
        tool_call_id: call.id,
        content: JSON.stringify(result),
        artifact: result,
        status: 'error',
      });
    }

    const parsed = languageSchoolToolResultSchema.safeParse(message.artifact);
    if (!parsed.success || (!parsed.data.result.ok && parsed.data.result.error.code === 'OPERATION_FAILED')) {
      throw new Error(executionError);
    }
    return { message, result: parsed.data };
  }

  return { tools, execute };
}
