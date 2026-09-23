import { slotSchema, trialClassSchema } from '@supportflow/contracts/language-school';
import type { Slot, TrialClass } from '@supportflow/contracts/language-school';
import type { TrialClassRepository } from '../domain/trial-class-repository.js';

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
}
