import type { LanguageSchoolChatResponse, LanguageSchoolToolResult, Slot } from '@supportflow/contracts/language-school';

function SlotDetails({ slot }: { slot: Pick<Slot, 'startsAt' | 'timezone'> }) {
  const date = new Date(slot.startsAt);
  return <dl className="school-facts slot-facts">
    <div><dt>Data</dt><dd><time dateTime={slot.startsAt}>{new Intl.DateTimeFormat('pt-BR', { timeZone: slot.timezone, dateStyle: 'long' }).format(date)}</time></dd></div>
    <div><dt>Horário</dt><dd>{new Intl.DateTimeFormat('pt-BR', { timeZone: slot.timezone, hour: '2-digit', minute: '2-digit' }).format(date)}</dd></div>
    <div><dt>Fuso horário</dt><dd>{slot.timezone.replaceAll('_', ' ')}</dd></div>
  </dl>;
}

export function TrialClassPreview({ action, disabled, confirming, retry, onConfirm }: {
  action: NonNullable<LanguageSchoolChatResponse['pendingAction']>;
  disabled: boolean; confirming: boolean; retry: boolean; onConfirm: () => void;
}) {
  if (action.kind !== 'schedule_trial_class') return null;
  const { lead, course, slot } = action.preview;
  return <section className="result-card trial-preview" aria-label="Revisar aula experimental" aria-busy={confirming}>
    <p className="eyebrow">Prévia oficial · aguardando confirmação</p>
    <h2>Revisar aula experimental</h2>
    <dl className="school-facts"><div><dt>Aluno</dt><dd>{lead.name}</dd></div><div><dt>Curso</dt><dd>{course.name}</dd></div></dl>
    <SlotDetails slot={slot} />
    <p className="registration-note">Agenda demonstrativa. A vaga ainda não foi reservada e pode deixar de estar disponível. Para corrigir, envie uma mensagem.</p>
    <button type="button" className="send-button" disabled={disabled} onClick={onConfirm}>
      {confirming ? 'Confirmando aula…' : retry ? 'Tentar confirmar novamente' : 'Confirmar aula experimental'}
    </button>
  </section>;
}

export function TrialClassResults({ results }: { results: LanguageSchoolToolResult[] }) {
  return results.map((entry, index) => {
    if (entry.tool === 'get_available_slots') {
      if (!entry.result.ok) return <p key={index} className="result-notice">Não foi possível consultar os horários deste curso. Continue a conversa.</p>;
      const { slots } = entry.result.data;
      return <section key={index} className="schedule-results" aria-label="Horários disponíveis">
        <p className="official-label">Horários oficiais · agenda demonstrativa</p>
        {slots.length === 0 ? <p className="result-notice">Não há horários disponíveis no momento.</p>
          : <><ul className="slot-list">{slots.map((slot, position) => <li key={slot.slotId} className="result-card">
            <h3>Opção {position + 1}</h3><SlotDetails slot={slot} />
          </li>)}</ul><p className="registration-note">Diga a data e o horário que prefere. Consultar não reserva a vaga.</p></>}
      </section>;
    }
    if (entry.tool !== 'schedule_trial_class') return null;
    if (!entry.result.ok) return <p key={index} className="result-notice" aria-label="Resultado oficial da aula">
      {entry.result.error.code === 'CONFIRMATION_REQUIRED' ? 'Aula aguardando confirmação. Revise a prévia atual.'
        : entry.result.error.code === 'SLOT_UNAVAILABLE' ? 'Este horário não está mais disponível. Consulte os horários novamente.'
          : 'Não foi possível preparar a aula. Confira o cadastro e a escolha do horário.'}
    </p>;
    const { outcome, booking } = entry.result.data;
    return <article key={index} className="result-card trial-receipt" aria-label="Recibo oficial da aula">
      <p className="eyebrow">Resultado oficial · agenda demonstrativa</p>
      <h3>{outcome === 'created' ? 'Aula experimental confirmada.' : 'Esta aula experimental já estava confirmada.'}</h3>
      <dl className="school-facts"><div><dt>Curso</dt><dd>{booking.courseId}</dd></div><div><dt>Status</dt><dd>Confirmado</dd></div></dl>
      <SlotDetails slot={booking} />
      <p className="registration-note">Identificador da reserva: {booking.id}</p>
    </article>;
  });
}
