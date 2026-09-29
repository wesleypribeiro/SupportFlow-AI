'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import { confirmChatAction, sendChatMessage } from './chat-api';
import { CatalogResults } from './catalog-results';
import { LeadPreview, LeadResults } from './lead-results';
import { TrialClassPreview, TrialClassResults } from './trial-class-results';
import { HandoffResults } from './handoff-results';

type Turn = {
  id: number;
  message: string | null;
  status: 'pending' | 'failed' | 'complete';
  response: Pick<LanguageSchoolChatResponse, 'reply' | 'results'> | null;
};
type ChatError = { kind: 'retry' | 'missing'; message: string; turnId: number };
type ConfirmationError = { kind: 'retry' | 'missing' | 'stale'; message: string };

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [currentPendingAction, setCurrentPendingAction] = useState<LanguageSchoolChatResponse['pendingAction']>(null);
  const [confirmationError, setConfirmationError] = useState<ConfirmationError | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const inFlight = useRef(false);
  const nextTurnId = useRef(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const missing = error?.kind === 'missing' || confirmationError?.kind === 'missing';
  const busy = sending || confirming;

  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [turns, busy, currentPendingAction]);
  useEffect(() => {
    if (!busy && !missing) field.current?.focus();
  }, [busy, missing]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || inFlight.current || missing) return;
    // O ref fecha a janela entre dois submits e o próximo render do React.
    inFlight.current = true;
    setSending(true);
    const previous = turns.find((turn) => turn.id === error?.turnId && turn.message === message);
    const turnId = previous?.id ?? nextTurnId.current++;
    setTurns((current) => previous
      ? current.map((turn) => turn.id === turnId ? { ...turn, status: 'pending' } : turn)
      : [...current, { id: turnId, message, status: 'pending', response: null }]);
    setError(null);

    const outcome = await sendChatMessage(message, conversationId);
    if (outcome.ok) {
      const { reply, results } = outcome.response;
      setTurns((current) => current.map((turn) => turn.id === turnId
        ? { ...turn, status: 'complete', response: { reply, results } } : turn));
      setConversationId(outcome.response.conversationId);
      setCurrentPendingAction(outcome.response.pendingAction);
      setConfirmationError(null);
      setDraft('');
    } else {
      setTurns((current) => current.map((turn) => turn.id === turnId ? { ...turn, status: 'failed' } : turn));
      setError({ kind: outcome.kind, message: outcome.message, turnId });
    }
    inFlight.current = false;
    setSending(false);
  }

  async function confirm() {
    if (inFlight.current || missing || !conversationId || !currentPendingAction) return;
    inFlight.current = true;
    setConfirming(true);
    setConfirmationError(null);
    const outcome = await confirmChatAction(conversationId, currentPendingAction.actionId);
    if (outcome.ok) {
      const id = nextTurnId.current++;
      setTurns((current) => [...current, { id, message: null, status: 'complete', response: outcome.response }]);
      setConversationId(outcome.response.conversationId);
      setCurrentPendingAction(outcome.response.pendingAction);
    } else {
      setConfirmationError({ kind: outcome.kind, message: outcome.message });
      if (outcome.kind === 'stale' || outcome.kind === 'missing') setCurrentPendingAction(null);
      // Nos demais erros, preserve a mesma ação para recuperar seu recibo no retry.
    }
    inFlight.current = false;
    setConfirming(false);
  }

  function startNewConversation() {
    if (inFlight.current) return;
    setTurns([]);
    setConversationId(undefined);
    setError(null);
    setConfirmationError(null);
    setCurrentPendingAction(null);
    field.current?.focus();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <main className="app-shell">
      <header className="brand-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">sf</span>
          <span>SupportFlow <span className="brand-ai">AI</span></span>
        </div>
        <span className="demo-badge">Demonstração</span>
      </header>
      <section className="chat-panel" aria-labelledby="chat-title">
        <header className="chat-header">
          <div><p className="eyebrow">Seu próximo idioma</p><h1 id="chat-title">Começa com uma conversa.</h1></div>
          <button className="new-chat" type="button" onClick={startNewConversation}
            disabled={busy || turns.length === 0}>Nova conversa <span aria-hidden="true">↗</span></button>
        </header>
        <div className="chat-feed" ref={feed} role="log" aria-label="Histórico da conversa" aria-live="polite" tabIndex={0}>
          {turns.length === 0 ? (
            <div className="empty-chat">
              <span className="conversation-symbol" aria-hidden="true">Olá<span>!</span></span>
              <h2>O que você quer aprender?</h2>
              <p>Conheça a escola, explore cursos e tire suas dúvidas. Comece por uma pergunta.</p>
              <div className="suggestions">
                {['Quais cursos vocês oferecem?', 'Quero conhecer a escola.'].map((message) => (
                  <button type="button" key={message} onClick={() => { setDraft(message); field.current?.focus(); }}>
                    {message} <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : turns.map((turn) => (
            <div className="chat-turn" key={turn.id}>
              {turn.message !== null && <article className="message visitor-message" aria-label="Mensagem do visitante">
                <p className="speaker">Você</p><p className="message-text">{turn.message}</p>
                {turn.status === 'failed' && <span className="failed-label">Sem resposta · tente novamente</span>}
              </article>}
              {turn.response && (
                <article className="message assistant-message" aria-label="Resposta do assistente">
                  <p className="speaker"><span className="assistant-dot" aria-hidden="true" /> SupportFlow AI</p>
                  <p className="message-text">{turn.response.reply}</p>
                  <CatalogResults results={turn.response.results} />
                  <LeadResults results={turn.response.results} />
                  <TrialClassResults results={turn.response.results} />
                  <HandoffResults results={turn.response.results} />
                </article>
              )}
            </div>
          ))}
          {currentPendingAction && <LeadPreview action={currentPendingAction} disabled={busy || missing}
            confirming={confirming} retry={confirmationError?.kind === 'retry'} onConfirm={confirm} />}
          {currentPendingAction && <TrialClassPreview action={currentPendingAction} disabled={busy || missing}
            confirming={confirming} retry={confirmationError?.kind === 'retry'} onConfirm={confirm} />}
          {sending && <p className="processing" role="status"><span className="loading-dot" aria-hidden="true" /> Preparando sua resposta…</p>}
          {confirming && <p className="processing" role="status">{currentPendingAction?.kind === 'schedule_trial_class' ? 'Confirmando sua aula…' : 'Confirmando seu cadastro…'}</p>}
        </div>
        <footer className="composer-area">
          {error && (
            <div className="chat-error" role="alert">
              <p>{error.message} Sua mensagem está preservada.</p>
              {missing && <button type="button" onClick={startNewConversation}>Iniciar nova conversa</button>}
            </div>
          )}
          {confirmationError && (
            <div className="chat-error" role="alert">
              <p>{confirmationError.message}</p>
              {confirmationError.kind === 'missing' && <button type="button" onClick={startNewConversation}>Iniciar nova conversa</button>}
            </div>
          )}
          <form onSubmit={submit} aria-label="Enviar mensagem">
            <label htmlFor="chat-message" className="field-label">Sua mensagem</label>
            <div className="composer">
              <textarea id="chat-message" ref={field} rows={2} maxLength={2000} value={draft}
                placeholder="Conte o que você procura…" aria-describedby="message-help"
                disabled={busy || missing} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} />
              <button className="send-button" type="submit" disabled={busy || missing || !draft.trim()}>
                {sending ? 'Enviando…' : error ? 'Tentar novamente' : 'Enviar'} <span aria-hidden="true">↑</span>
              </button>
            </div>
            <div className="composer-meta">
              <span id="message-help">Enter envia · Shift+Enter quebra a linha</span><span>Até 2.000 caracteres</span>
            </div>
          </form>
        </footer>
      </section>
      <p className="demo-note">Ambiente de demonstração · Dados fictícios · A conversa não é salva ao recarregar.</p>
    </main>
  );
}
