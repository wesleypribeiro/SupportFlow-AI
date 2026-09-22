import type { Course, School } from '@supportflow/contracts/language-school';

// Dados exclusivamente fictícios para a demonstração local.
export const schoolFixture: School = {
  id: 'school_demo',
  name: 'Escola Demonstração de Idiomas',
  description: 'Escola fictícia de idiomas para demonstração do SupportFlow AI.',
  address: 'Rua Fictícia dos Idiomas, 100, Cidade Exemplo — endereço demonstrativo.',
  contact: 'atendimento@escola-demonstracao.example',
  openingHours: 'Segunda a sexta, das 9h às 18h.',
  timezone: 'America/Sao_Paulo',
};

export const courseFixtures: readonly Course[] = [
  {
    id: 'course_english_travel',
    name: 'Inglês para viagens',
    description: 'Curso demonstrativo de inglês para comunicação em viagens.',
    language: 'Inglês',
    modality: 'online',
    active: true,
    price: { amountCents: 35000, currency: 'BRL', billingPeriod: 'month' },
  },
  {
    id: 'course_spanish_conversation',
    name: 'Conversação em espanhol',
    description: 'Curso demonstrativo de espanhol para conversas do cotidiano.',
    language: 'Espanhol',
    modality: 'in_person',
    active: true,
    price: null,
  },
  {
    id: 'course_french_intro',
    name: 'Introdução ao francês',
    description: 'Curso demonstrativo introdutório de francês.',
    language: 'Francês',
    modality: 'online',
    active: true,
    price: { amountCents: 0, currency: 'BRL', billingPeriod: 'course' },
  },
  {
    id: 'course_german_foundations',
    name: 'Fundamentos de alemão',
    description: 'Curso demonstrativo de alemão fora da oferta comercial atual.',
    language: 'Alemão',
    modality: 'in_person',
    active: false,
    price: { amountCents: 28000, currency: 'BRL', billingPeriod: 'month' },
  },
];
