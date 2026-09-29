import { describe, expect, it } from 'vitest';
import type { Slot } from '@supportflow/contracts/language-school';
import { applyContextPatch, createConversationContext } from '../../src/modules/language-school/domain/conversation-context.js';
import { slotFixtures } from '../../src/modules/language-school/infrastructure/slot-fixtures.js';

const courseId = 'course_english_travel';
const slotA = 'slot_english_a';
const slotB = 'slot_english_b';
const eligible = slotFixtures.filter((slot) => [slotA, slotB].includes(slot.slotId));
const a = eligible.find((slot) => slot.slotId === slotA)!;
const context = { ...createConversationContext(), courseId, slotId: slotA, revision: 7 };
const select = (slotId: string, evidence: string, message = `Escolho ${evidence}.`, slots: readonly Slot[] = eligible) =>
  applyContextPatch(context, {
    goal: null, name: null, contact: null, courseReference: null, slotReference: { slotId, evidence },
  }, message, [], slots);

describe('evidência de slot vinculada à data/hora oficial', () => {
  it.each([
    [slotA, '11/06 às 10h'],
    [slotA, '11/06/2030 às 10:00'],
    [slotA, '11 de junho de 2030 às 10:00'],
    [slotB, '12/06 às 14h'],
    [slotB, '12/6/2030 às 14h00'],
    [slotB, '12 DE JUNHO DE 2030 às 14:00'],
  ])('aceita %s somente com evidência correspondente: %s', (slotId, evidence) => {
    const result = select(slotId, evidence);
    expect(result).toEqual({ ...context, slotId, revision: slotId === slotA ? 7 : 8 });
    expect(context).toMatchObject({ slotId: slotA, revision: 7 });
  });

  it.each([
    [slotB, '11/06 às 10h'], // O modelo tenta trocar A por B.
    [slotA, '12/06 às 14h'],
    [slotB, 'Escolho'],
    [slotB, '14h'],
    [slotB, '12/06'],
    [slotB, 'a segunda opção'],
    [slotB, 'amanhã às 14h'],
    [slotB, '12/06/2031 às 14h'],
    [slotB, '12/06 às 14h30'],
    [slotB, '11/06 às 10h ou 12/06 às 14h'],
    [slotA, '11/06 às 10h ou 14h'],
    ['slot_invented', '12/06 às 14h'],
  ])('preserva seleção e revisão para %s com evidência insuficiente/incompatível: %s', (slotId, evidence) => {
    expect(select(slotId, evidence)).toEqual(context);
  });

  it('não permite que evidence esconda outra opção presente na mensagem', () => {
    expect(select(slotB, '12/06 às 14h', 'Escolho 11/06 às 10h ou 12/06 às 14h.')).toEqual(context);
    // Mesmo uma alternativa não cadastrada torna a escolha insuficiente.
    expect(select(slotB, '12/06 às 14h', 'Escolho 12/06 às 14h ou 13/06 às 16h.')).toEqual(context);
  });

  it('continua exigindo evidence literal da mensagem atual', () => {
    expect(select(slotB, '12/06 às 14h', 'Pode continuar?')).toEqual(context);
  });

  it('não usa o ID da LLM para desempatar dois slots com a mesma representação', () => {
    const slots = [...eligible, { ...a, slotId: 'slot_same_time' }];
    expect(select(slotA, '11/06 às 10h', undefined, slots)).toEqual(context);
  });

  it('sem ano, não escolhe silenciosamente entre anos diferentes', () => {
    const slots = [...eligible, { ...a, slotId: 'slot_next_year', startsAt: '2031-06-11T10:00:00-03:00' }];
    expect(select('slot_next_year', '11/06 às 10h', undefined, slots)).toEqual(context);
    expect(select('slot_next_year', '11/06/2031 às 10h', undefined, slots))
      .toEqual({ ...context, slotId: 'slot_next_year', revision: 8 });
  });

  it('associa no fuso oficial da UI, inclusive quando a data local difere do ISO', () => {
    const localMidnight: Slot = { ...a, slotId: 'slot_local', startsAt: '2030-06-12T01:30:00Z' };
    const slots = [...eligible, localMidnight];
    expect(select(localMidnight.slotId, '11 de junho de 2030 às 22:30', undefined, slots))
      .toEqual({ ...context, slotId: localMidnight.slotId, revision: 8 });
    expect(select(localMidnight.slotId, '12/06 às 01h30', undefined, slots)).toEqual(context);
    expect(localMidnight.startsAt).toBe('2030-06-12T01:30:00Z');
  });

  it('não aceita data/hora coincidente de outro curso', () => {
    const foreign = { ...a, slotId: 'slot_other_course', courseId: 'course_french_intro' };
    expect(select(foreign.slotId, '11/06 às 10h', undefined, [...eligible, foreign])).toEqual(context);
  });

  it('não aplica fragmentos de datas ou horas incompatíveis', () => {
    for (const evidence of ['111/06 às 10h', '11/06/20300 às 10h', '11/06 às 110h', '11/06 às 10:00:30']) {
      expect(select(slotA, evidence)).toEqual(context);
    }
  });
});
