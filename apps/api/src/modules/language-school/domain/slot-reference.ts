import type { Slot } from '@supportflow/contracts/language-school';

const months = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Vocabulário limitado à data brasileira numérica ou por extenso e hora explícita.
// Não resolve ordinais, datas relativas ou texto livre em um calendário novo.
function readSelection(text: string) {
  const dates = [...text.matchAll(new RegExp(
    `(?<![\\p{L}\\p{N}_/])(\\d{1,2})[ \\t]*(?:/(\\d{1,2})(?:/(\\d{4}))?|de[ \\t]+(${months.join('|')})(?:[ \\t]+de[ \\t]+(\\d{4}))?)(?![\\p{L}\\p{N}_/])`,
    'giu',
  ))];
  const times = [...text.matchAll(/(?<![\p{L}\p{N}_:])(\d{1,2})(?::(\d{2})|h(\d{2})?)(?![\p{L}\p{N}_:])/giu)];
  // Mesmo que a evidence recorte só uma opção, a mensagem completa deve ser única.
  if (dates.length !== 1 || times.length !== 1) return null;
  const date = dates[0]!;
  const time = times[0]!;
  const year = date[3] ?? date[5];
  return {
    day: Number(date[1]),
    month: date[2] ? Number(date[2]) : months.indexOf(date[4]!.toLocaleLowerCase('pt-BR')) + 1,
    year: year === undefined ? null : Number(year),
    hour: Number(time[1]),
    minute: Number(time[2] ?? time[3] ?? 0),
  };
}

export function resolveSlotReference(
  reference: { slotId: string; evidence: string },
  message: string,
  eligibleSlots: readonly Slot[],
): string | null {
  const evidence = readSelection(reference.evidence);
  const fullMessage = readSelection(message);
  if (!evidence || !fullMessage) return null;

  const matches = eligibleSlots.filter((slot) => {
    // A mesma data/hora apresentada na UI: startsAt projetado no timezone oficial,
    // nunca no fuso do processo nem apenas nos caracteres do ISO.
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: slot.timezone, day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(slot.startsAt));
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    return [evidence, fullMessage].every((selection) =>
      selection.day === value('day') && selection.month === value('month')
      && (selection.year === null || selection.year === value('year'))
      && selection.hour === value('hour') && selection.minute === value('minute'));
  });
  // O ID proposto não desempata evidências ambíguas nem substitui data/hora.
  return matches.length === 1 && matches[0]!.slotId === reference.slotId
    ? matches[0]!.slotId : null;
}
