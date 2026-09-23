import { randomUUID } from 'node:crypto';
import { scheduleTrialClassInputSchema, slotSchema, trialClassSchema } from '@supportflow/contracts/language-school';
import type { ScheduleTrialClassInput, Slot, TrialClass } from '@supportflow/contracts/language-school';
import type { SlotReservationResult, TrialClassRepository } from '../domain/trial-class-repository.js';

export class InMemoryTrialClassRepository implements TrialClassRepository {
  private readonly slots: readonly Slot[];
  private readonly bookingsBySlot: Map<string, TrialClass>;

  constructor(slots: readonly Slot[], bookings: readonly TrialClass[] = []) {
    this.slots = structuredClone(slotSchema.array().parse(slots));
    this.bookingsBySlot = new Map(
      trialClassSchema.array().parse(bookings).map((booking) => [booking.slotId, structuredClone(booking)]),
    );
  }

  async listSlotsByCourseId(courseId: string): Promise<Slot[]> {
    return structuredClone(this.slots.filter((slot) => slot.courseId === courseId));
  }

  async findConfirmedBySlotId(slotId: string): Promise<TrialClass | null> {
    const booking = this.bookingsBySlot.get(slotId);
    return booking ? structuredClone(booking) : null;
  }

  async findSlotById(slotId: string): Promise<Slot | null> {
    const slot = this.slots.find((entry) => entry.slotId === slotId);
    return slot ? structuredClone(slot) : null;
  }

  async reserveSlot(input: ScheduleTrialClassInput, now: Date): Promise<SlotReservationResult> {
    const { leadId, slotId } = scheduleTrialClassInputSchema.parse(input);
    const currentInstant = now.getTime();
    if (!Number.isFinite(currentInstant)) throw new Error('Relógio inválido.');

    // Fronteira atômica local: nenhum await/yield entre ler, decidir e inserir.
    // Uma implementação em banco deverá garantir isto com constraint/transação.
    const slot = this.slots.find((entry) => entry.slotId === slotId);
    if (!slot) return { outcome: 'not_found' };
    const existing = this.bookingsBySlot.get(slotId);
    if (existing) return existing.leadId === leadId
      ? { outcome: 'existing', booking: structuredClone(existing) }
      : { outcome: 'unavailable' };
    if (Date.parse(slot.startsAt) <= currentInstant) return { outcome: 'unavailable' };

    const booking = trialClassSchema.parse({
      id: randomUUID(), leadId, courseId: slot.courseId, slotId: slot.slotId,
      startsAt: slot.startsAt, timezone: slot.timezone, status: 'confirmed',
    });
    this.bookingsBySlot.set(slotId, structuredClone(booking));
    return { outcome: 'created', booking: structuredClone(booking) };
  }
}
