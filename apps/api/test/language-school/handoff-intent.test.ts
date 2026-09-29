import { describe, expect, it } from 'vitest';
import { handoffOffer, resolveHandoffIntent } from '../../src/modules/language-school/domain/handoff-intent.js';

describe('intenção conservadora de atendimento humano', () => {
  it.each([
    'Quero falar com alguém.', 'Prefiro um atendente.', 'Pode me passar para uma pessoa?',
    'Não quero me cadastrar agora. Prefiro falar com uma pessoa.',
    'Antes disso, quero falar com uma pessoa.', 'Preciso falar com um atendente sobre outro assunto.',
    'Quero atendimento humano.', 'Gostaria de falar com uma pessoa.',
  ])('aceita pedido explícito: %s', (message) => {
    expect(resolveHandoffIntent(message, null)).toBe('request');
  });
  it.each(['Sim', 'Sim, por favor.', 'Aceito o encaminhamento.', 'Pode registrar.'])(
    'aceitação %s exige oferta realmente apresentada', (message) => {
      expect(resolveHandoffIntent(message, handoffOffer)).toBe('accepted_offer');
      expect(resolveHandoffIntent(message, null)).toBeNull();
      expect(resolveHandoffIntent(message, 'Deseja confirmar o cadastro?')).toBeNull();
      expect(resolveHandoffIntent(message, 'Confirma a aula experimental?')).toBeNull();
    },
  );
  it.each([
    'Olá', 'Não quero falar com alguém.', 'Não quero atendimento humano.',
    'Talvez queira falar com alguém.', 'Se eu quiser falar com alguém?',
    'Meu amigo disse "quero falar com alguém".', 'Quero falar com alguém ou talvez não.',
    'Quero aprender inglês.', 'Sim, mas não quero encaminhamento.',
  ])('não aceita mensagem insuficiente/negada: %s', (message) => {
    expect(resolveHandoffIntent(message, handoffOffer)).toBeNull();
  });
  it('oferta com outra decisão ou afirmação de sucesso não autoriza Sim', () => {
    expect(resolveHandoffIntent('Sim', `${handoffOffer} Quer confirmar o cadastro também?`)).toBeNull();
    expect(resolveHandoffIntent('Sim', 'Já registrei sua solicitação.')).toBeNull();
    expect(resolveHandoffIntent('Sim', 'Você gostaria de falar com um atendente?')).toBe('accepted_offer');
  });
});
