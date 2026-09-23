import type { CreateLeadInput, LanguageSchoolChatResponse, LanguageSchoolToolResult } from '@supportflow/contracts/language-school';

function LeadDetails({ data }: { data: CreateLeadInput }) {
  return <dl className="school-facts">
    <div><dt>Nome</dt><dd>{data.name}</dd></div>
    <div><dt>{data.contact.type === 'email' ? 'E-mail' : 'Telefone'}</dt><dd>{data.contact.value}</dd></div>
    <div><dt>Identificador do curso</dt><dd>{data.courseId}</dd></div>
    <div><dt>Objetivo</dt><dd>{data.goal ?? 'Objetivo não informado'}</dd></div>
  </dl>;
}

export function LeadPreview({ action, disabled, confirming, retry, onConfirm }: {
  action: NonNullable<LanguageSchoolChatResponse['pendingAction']>;
  disabled: boolean;
  confirming: boolean;
  retry: boolean;
  onConfirm: () => void;
}) {
  if (action.kind !== 'create_lead') return null;
  return <section className="result-card lead-preview" aria-label="Revisar cadastro" aria-busy={confirming}>
    <p className="eyebrow">Prévia oficial · aguardando confirmação</p>
    <h2>Revisar cadastro</h2>
    <p>Confira seus dados. Para corrigir, envie uma mensagem antes de confirmar.</p>
    <LeadDetails data={action.preview} />
    <button type="button" className="send-button" disabled={disabled} onClick={onConfirm}>
      {confirming ? 'Confirmando cadastro…' : retry ? 'Tentar confirmar novamente' : 'Confirmar cadastro'}
    </button>
    <p className="registration-note">Esta confirmação é somente do cadastro.</p>
  </section>;
}

export function LeadResults({ results }: { results: LanguageSchoolToolResult[] }) {
  return results.map((entry, index) => {
    if (entry.tool !== 'create_lead') return null;
    if (!entry.result.ok) return <p className="result-notice lead-notice" key={index}>
      {entry.result.error.code === 'CONFIRMATION_REQUIRED'
        ? 'Cadastro aguardando confirmação. Revise a prévia atual antes de confirmar.'
        : 'Não foi possível preparar o cadastro. Confira seus dados e continue a conversa.'}
    </p>;
    const { outcome, lead } = entry.result.data;
    const title = { created: 'Cadastro realizado.', updated: 'Cadastro atualizado.', existing: 'Dados já cadastrados.' }[outcome];
    return <article className="result-card lead-receipt" aria-label="Resultado oficial do cadastro" key={index}>
      <p className="eyebrow">Resultado oficial</p><h3>{title}</h3>
      <LeadDetails data={lead} />
      <p className="registration-note">Identificador do cadastro: {lead.id}</p>
    </article>;
  });
}
