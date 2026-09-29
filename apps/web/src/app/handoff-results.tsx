import type { LanguageSchoolToolResult } from '@supportflow/contracts/language-school';

export function HandoffResults({ results }: { results: LanguageSchoolToolResult[] }) {
  return results.map((entry, index) => {
    if (entry.tool !== 'transfer_to_human') return null;
    if (!entry.result.ok) return <p key={index} className="result-notice handoff-result" aria-label="Falha na solicitação de atendimento">
      {entry.result.error.code === 'INVALID_INPUT'
        ? 'Nenhuma nova solicitação registrada. Informe se deseja solicitar atendimento humano.'
        : 'Não foi possível registrar a solicitação de atendimento humano. Tente novamente.'}
    </p>;
    const { request } = entry.result.data;
    return <article key={index} className="result-card handoff-result" aria-label="Protocolo oficial de atendimento">
      <p className="eyebrow">Registro local · demonstração</p>
      <h3>Solicitação de atendimento registrada</h3>
      <dl className="school-facts">
        <div><dt>Protocolo</dt><dd>{request.id}</dd></div>
        <div><dt>Motivo</dt><dd>{request.reason}</dd></div>
        <div><dt>Status</dt><dd>{request.status === 'requested' ? 'Solicitado' : null}</dd></div>
      </dl>
      <p className="registration-note">Esta é uma solicitação local de demonstração. Nenhum atendimento humano ao vivo foi iniciado e nenhuma notificação externa foi enviada.</p>
    </article>;
  });
}
