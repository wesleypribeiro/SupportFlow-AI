// Reconhecimento conservador: não transforma uma tool call em consentimento.
// Só a última oferta apresentada pode justificar uma aceitação curta.
export const handoffOffer = 'Posso registrar uma solicitação local de atendimento humano nesta demonstração?';

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function resolveHandoffIntent(message: string, previousAssistantReply: string | null): 'request' | 'accepted_offer' | null {
  const current = normalize(message);
  // Recusas, hipóteses, discurso citado e mensagens contraditórias pedem esclarecimento.
  if (/["“”]/u.test(current) || /\b(?:nao|nunca|sem)\b[^.!?;]*(?:atendente|atendimento humano|falar com|conversar com|encaminhamento)/u.test(current)
    || /\b(?:talvez|se|caso|exemplo)\b/u.test(current)) return null;
  const person = '(?:alguem|uma pessoa|um humano|um atendente|uma atendente|atendimento humano)';
  const request = new RegExp(`^(?:antes disso,? |agora,? )?(?:eu )?(?:(?:quero|prefiro|preciso(?: de)?|gostaria de) (?:(?:falar|conversar) com )?${person}|(?:pode|poderia) me (?:passar|encaminhar) para ${person})(?:[ ,.!?;]|$)`, 'u');
  if (current.split(/[.!?;]+/u).some((sentence) => request.test(sentence.trim()))) return 'request';

  const offer = previousAssistantReply === null ? '' : normalize(previousAssistantReply);
  const offered = [normalize(handoffOffer), 'voce gostaria de falar com um atendente?',
    'posso registrar uma solicitacao local de atendimento humano?'];
  const acceptance = /^(?:sim(?:,? por favor)?|aceito(?: o encaminhamento| a oferta)?|pode registrar|pode encaminhar)[.!]?$/u;
  return offered.includes(offer) && acceptance.test(current) ? 'accepted_offer' : null;
}
