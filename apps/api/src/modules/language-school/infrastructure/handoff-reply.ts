import { languageSchoolToolResultSchema } from '@supportflow/contracts/language-school';

// A apresentação deste efeito local é determinística, mesmo se a LLM redigir
// uma promessa inexistente. Somente sucesso validado permite recuperar redação.
export function describeHandoffResults(results: readonly unknown[]) {
  const handoffs = results.map((entry) => languageSchoolToolResultSchema.parse(entry))
    .filter((entry) => entry.tool === 'transfer_to_human');
  if (!handoffs.length) return undefined;
  const replies = handoffs.map(({ result }) => result.ok
    ? `Sua solicitação de atendimento humano foi registrada nesta demonstração. Protocolo: ${result.data.request.id}. Isso não inicia atendimento ao vivo nem envia notificações externas.`
    : result.error.code === 'INVALID_INPUT'
      ? 'Não foi registrada uma nova solicitação. Confirme que deseja solicitar atendimento humano nesta demonstração.'
      : 'Não foi possível registrar a solicitação de atendimento humano. Tente novamente.');
  return { reply: [...new Set(replies)].join('\n'), hasRecordedWrite: handoffs.some(({ result }) => result.ok) };
}
