import { describe, expect, it } from 'vitest';
import { trialClassSchema } from '@supportflow/contracts/language-school';
import { InMemoryTrialClassRepository } from '../../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../../src/modules/language-school/infrastructure/slot-fixtures.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const input = () => ({ leadId: 'lead_ana', slotId: 'slot_english_a' });

describe('reserveSlot: fronteira atômica de ocupação', () => {
  it('created gera ID no backend e usa exclusivamente os dados oficiais do slot', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    const result = await repository.reserveSlot(input(), now());
    expect(result.outcome).toBe('created');
    if (!('booking' in result)) throw new Error('Reserva esperada.');
    const slot = slotFixtures.find((entry) => entry.slotId === input().slotId)!;
    expect(trialClassSchema.parse(result.booking)).toEqual({ ...slot, id: expect.any(String), leadId: 'lead_ana', status: 'confirmed' });
    expect(result.booking.id).not.toBe(input().leadId);
    expect(result.booking.id).not.toBe(input().slotId);
    expect(await repository.findConfirmedBySlotId(slot.slotId)).toEqual(result.booking);
  });

  it('repetição do mesmo lead recupera existing; outro lead recebe unavailable', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    const first = await repository.reserveSlot(input(), now());
    if (!('booking' in first)) throw new Error('Reserva esperada.');
    expect(await repository.reserveSlot(input(), now())).toEqual({ outcome: 'existing', booking: first.booking });
    expect(await repository.reserveSlot({ ...input(), leadId: 'lead_bruno' }, now())).toEqual({ outcome: 'unavailable' });
    expect(await repository.findConfirmedBySlotId(input().slotId)).toEqual(first.booking);
  });

  it('entradas e retornos não são referências mutáveis ao registro', async () => {
    const slots = structuredClone([...slotFixtures]);
    const repository = new InMemoryTrialClassRepository(slots);
    const request = input();
    const saved = await repository.reserveSlot(request, now());
    if (!('booking' in saved)) throw new Error('Reserva esperada.');
    const snapshot = structuredClone(saved.booking);
    request.leadId = 'lead_changed'; request.slotId = 'slot_changed';
    slots.find((s) => s.slotId === snapshot.slotId)!.startsAt = '2040-01-01T00:00:00Z';
    saved.booking.timezone = 'UTC';
    const repeated = await repository.reserveSlot(input(), now());
    if (!('booking' in repeated)) throw new Error('Reserva esperada.');
    repeated.booking.leadId = 'lead_changed_return';
    const read = (await repository.findConfirmedBySlotId(snapshot.slotId))!;
    read.startsAt = '2040-01-01T00:00:00Z';
    expect(await repository.findConfirmedBySlotId(snapshot.slotId)).toEqual(snapshot);
  });

  it.each([['lead_a', 'lead_b'], ['lead_b', 'lead_a']])('concorrência %s / %s: exatamente um vencedor', async (first, second) => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    const results = await Promise.all([
      repository.reserveSlot({ ...input(), leadId: first }, now()),
      repository.reserveSlot({ ...input(), leadId: second }, now()),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'unavailable']);
    const winner = results.find((result) => result.outcome === 'created');
    if (!winner || !('booking' in winner)) throw new Error('Um vencedor esperado.');
    const bookings = await Promise.all(slotFixtures.map((slot) => repository.findConfirmedBySlotId(slot.slotId)));
    expect(bookings.filter(Boolean)).toEqual([winner.booking]);
  });

  it('duas confirmações concorrentes do mesmo lead geram created + existing com mesmo ID', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    const results = await Promise.all([repository.reserveSlot(input(), now()), repository.reserveSlot(input(), now())]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'existing']);
    const saved = await repository.findConfirmedBySlotId(input().slotId);
    for (const result of results) expect(result).toMatchObject({ booking: saved });
  });

  it('slot inexistente e instante inválido não criam reserva', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    expect(await repository.reserveSlot({ ...input(), slotId: 'slot_missing' }, now())).toEqual({ outcome: 'not_found' });
    await expect(repository.reserveSlot(input(), new Date('invalid'))).rejects.toThrow();
    expect(await repository.findConfirmedBySlotId(input().slotId)).toBeNull();
  });

  it.each(['2030-06-11T12:59:59Z', '2030-06-11T13:00:00Z', '2030-06-11T13:00:01Z'])(
    'revalida futuro estrito dentro da operação em %s, respeitando offset', async (instant) => {
      const repository = new InMemoryTrialClassRepository(slotFixtures);
      const result = await repository.reserveSlot(input(), new Date(instant));
      expect(result.outcome).toBe(instant === '2030-06-11T12:59:59Z' ? 'created' : 'unavailable');
    },
  );

  it('reserva existente continua recuperável após seu horário', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    const first = await repository.reserveSlot(input(), now());
    if (!('booking' in first)) throw new Error('Reserva esperada.');
    expect(await repository.reserveSlot(input(), new Date('2031-01-01T00:00:00Z')))
      .toEqual({ outcome: 'existing', booking: first.booking });
  });

  it.each(['id', 'bookingId', 'startsAt', 'timezone', 'courseId', 'confirmed'])(
    'não aceita campo %s fornecido como parte da reserva', async (field) => {
      const repository = new InMemoryTrialClassRepository(slotFixtures);
      await expect(repository.reserveSlot({ ...input(), [field]: 'forged' }, now())).rejects.toThrow();
      expect(await repository.findConfirmedBySlotId(input().slotId)).toBeNull();
    },
  );
});
