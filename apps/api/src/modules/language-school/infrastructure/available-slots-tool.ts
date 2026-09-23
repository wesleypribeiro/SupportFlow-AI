import { getAvailableSlotsInputSchema, getAvailableSlotsResultSchema } from '@supportflow/contracts/language-school';
import type { GetAvailableSlotsResult } from '@supportflow/contracts/language-school';
import { getAvailableSlots } from '../application/get-available-slots.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { TrialClassRepository } from '../domain/trial-class-repository.js';

function failure(code: 'INVALID_INPUT' | 'OPERATION_FAILED'): GetAvailableSlotsResult {
  return getAvailableSlotsResultSchema.parse({
    ok: false, error: { code, message: code === 'INVALID_INPUT'
      ? 'Entrada inválida para a consulta de horários.'
      : 'Não foi possível consultar os horários disponíveis.' },
  });
}

// Operação direta de leitura; ainda não registrada no LangChain.
export function createAvailableSlotsTool(composition: {
  schoolRepository: SchoolRepository;
  trialClassRepository: TrialClassRepository;
  now: () => Date;
}) {
  return async function get_available_slots(input: unknown): Promise<GetAvailableSlotsResult> {
    const parsed = getAvailableSlotsInputSchema.safeParse(input);
    if (!parsed.success) return failure('INVALID_INPUT');
    try {
      return getAvailableSlotsResultSchema.parse(await getAvailableSlots(composition, parsed.data.courseId));
    } catch {
      return failure('OPERATION_FAILED');
    }
  };
}
