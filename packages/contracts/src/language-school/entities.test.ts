import { describe, expect, it } from 'vitest';
import {
  contactSchema,
  courseSchema,
  courseSummarySchema,
  handoffSchema,
  leadSchema,
  priceSchema,
  schoolSchema,
  slotSchema,
  trialClassSchema,
} from './entities.js';

const school = {
  id: 'escola-demo',
  name: 'Escola Exemplo',
  description: 'Escola fictícia de idiomas.',
  address: 'Rua Exemplo, 100',
  contact: 'contato@example.com',
  openingHours: 'Segunda a sexta, das 09h às 18h',
  timezone: 'America/Sao_Paulo',
};

const price = { amountCents: 35000, currency: 'BRL', billingPeriod: 'month' };
const courseSummary = {
  id: 'ingles-viagem',
  name: 'Inglês',
  language: 'en',
  modality: 'online',
  active: true,
};
const course = {
  ...courseSummary,
  description: 'Inglês para situações do cotidiano.',
  price,
};
const contact = { type: 'email', value: 'aluno@example.com' };
const lead = {
  id: 'lead-demo',
  name: 'Ana Exemplo',
  contact,
  courseId: course.id,
  goal: 'Entrevistas de emprego',
};
const slot = {
  slotId: 'aula-segunda',
  courseId: course.id,
  startsAt: '2030-10-21T14:30:00-03:00',
  timezone: 'America/Sao_Paulo',
};
const booking = {
  id: 'reserva-demo',
  leadId: lead.id,
  ...slot,
  status: 'confirmed',
};
const handoff = {
  id: 'solicitacao-demo',
  reason: 'O visitante pediu atendimento humano.',
  status: 'requested',
};

const entities = [
  { name: 'escola', schema: schoolSchema, value: school },
  { name: 'preço', schema: priceSchema, value: price },
  { name: 'resumo de curso', schema: courseSummarySchema, value: courseSummary },
  { name: 'curso', schema: courseSchema, value: course },
  { name: 'contato', schema: contactSchema, value: contact },
  { name: 'lead', schema: leadSchema, value: lead },
  { name: 'horário', schema: slotSchema, value: slot },
  { name: 'reserva', schema: trialClassSchema, value: booking },
  { name: 'encaminhamento', schema: handoffSchema, value: handoff },
];

describe('entidades estruturadas da escola', () => {
  it.each(entities)('aceita $name válido sem modificar os dados', ({ schema, value }) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each(entities)('rejeita propriedades extras em $name', ({ schema, value }) => {
    expect(schema.safeParse({ ...value, internalContext: {} }).success).toBe(false);
  });

  it.each(entities)('exige os campos obrigatórios de $name', ({ schema }) => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('aceita IDs opacos sem exigir UUID e preserva textos sem normalizar', () => {
    const input = { ...lead, id: 'lead:001/local', name: ' Ana Exemplo ' };
    expect(leadSchema.parse(input)).toEqual(input);
  });

  it('rejeita textos obrigatórios vazios, IDs numéricos e dados institucionais inesperados', () => {
    expect(schoolSchema.safeParse({ ...school, name: '   ' }).success).toBe(false);
    expect(courseSchema.safeParse({ ...course, id: '' }).success).toBe(false);
    expect(leadSchema.safeParse({ ...lead, id: 123 }).success).toBe(false);
    expect(schoolSchema.safeParse({ ...school, address: { street: 'Rua Exemplo' } }).success)
      .toBe(false);
  });
});

describe('preços e cursos', () => {
  it('preserva centavos, moeda e periodicidade de um preço conhecido', () => {
    expect(courseSchema.parse(course).price).toEqual(price);
    expect(priceSchema.parse({ ...price, billingPeriod: 'course' }).billingPeriod)
      .toBe('course');
  });

  it('distingue preço indisponível de preço zero', () => {
    expect(courseSchema.parse({ ...course, price: null }).price).toBeNull();
    expect(courseSchema.parse({ ...course, price: { ...price, amountCents: 0 } }).price)
      .toEqual({ ...price, amountCents: 0 });
    expect(courseSchema.safeParse({ ...course, price: undefined }).success).toBe(false);
  });

  it('rejeita valor negativo, fracionário ou textual sem coerção', () => {
    for (const amountCents of [-1, 12.5, '35000']) {
      expect(priceSchema.safeParse({ ...price, amountCents }).success).toBe(false);
    }
    expect(priceSchema.safeParse({ ...price, currency: 'USD' }).success).toBe(false);
    expect(priceSchema.safeParse({ ...price, billingPeriod: 'year' }).success).toBe(false);
  });

  it('mantém os objetos de preço estritos mesmo dentro do curso', () => {
    expect(courseSchema.safeParse({ ...course, price: { ...price, discount: 10 } }).success)
      .toBe(false);
  });

  it('representa cursos ativos e inativos sem decidir sua oferta comercial', () => {
    expect(courseSchema.parse({ ...course, active: true }).active).toBe(true);
    expect(courseSchema.parse({ ...course, active: false }).active).toBe(false);
    expect(courseSummarySchema.parse({ ...courseSummary, active: false }).active).toBe(false);
    expect(courseSchema.safeParse({ ...course, active: 'false' }).success).toBe(false);
  });

  it('aceita as modalidades previstas e rejeita uma modalidade desconhecida', () => {
    expect(courseSchema.parse({ ...course, modality: 'in_person' }).modality).toBe('in_person');
    expect(courseSchema.safeParse({ ...course, modality: 'hybrid' }).success).toBe(false);
  });
});

describe('contato e cadastro', () => {
  it('valida email e telefone sem modificar o valor fornecido', () => {
    const phone = { type: 'phone', value: '+55 (11) 99999-1234' };
    expect(contactSchema.parse(contact)).toEqual(contact);
    expect(contactSchema.parse(phone)).toEqual(phone);
    expect(contactSchema.safeParse({ type: 'email', value: 'email-invalido' }).success)
      .toBe(false);
    expect(contactSchema.safeParse({ type: 'phone', value: 'ligue amanhã' }).success)
      .toBe(false);
    expect(contactSchema.safeParse({ type: 'phone', value: 11999991234 }).success)
      .toBe(false);
  });

  it('rejeita contato com tipo desconhecido e metadados internos aninhados', () => {
    expect(contactSchema.safeParse({ type: 'whatsapp', value: '+5511999991234' }).success)
      .toBe(false);
    expect(leadSchema.safeParse({
      ...lead,
      contact: { ...contact, verified: true },
    }).success).toBe(false);
    expect(leadSchema.safeParse({ ...lead, conversationId: 'conversa-outra' }).success)
      .toBe(false);
  });

  it('exige objetivo textual ou null, sem preencher o objetivo ausente', () => {
    expect(leadSchema.parse({ ...lead, goal: null }).goal).toBeNull();
    expect(leadSchema.safeParse({ ...lead, goal: undefined }).success).toBe(false);
    expect(leadSchema.safeParse({ ...lead, goal: ' ' }).success).toBe(false);
  });
});

describe('horários, reservas e encaminhamentos', () => {
  it('preserva o instante ISO com deslocamento e aceita UTC com fuso de apresentação', () => {
    expect(slotSchema.parse(slot)).toEqual(slot);
    expect(slotSchema.parse({ ...slot, startsAt: '2030-10-21T17:30:00Z' }).startsAt)
      .toBe('2030-10-21T17:30:00Z');
    expect(slotSchema.parse({ ...slot, timezone: 'UTC' }).timezone).toBe('UTC');
  });

  it('rejeita data sem deslocamento, data inexistente e objetos Date', () => {
    for (const startsAt of [
      '2030-10-21T14:30:00',
      '2030-02-30T14:30:00-03:00',
      new Date('2030-10-21T17:30:00Z'),
    ]) {
      expect(slotSchema.safeParse({ ...slot, startsAt }).success).toBe(false);
    }
  });

  it('exige um fuso válido também nos dados da escola', () => {
    expect(slotSchema.safeParse({ ...slot, timezone: 'America/Inexistente' }).success)
      .toBe(false);
    expect(schoolSchema.safeParse({ ...school, timezone: '-03:00' }).success).toBe(false);
  });

  it('representa um instante passado sem aplicar a regra de disponibilidade no contrato', () => {
    const pastSlot = { ...slot, startsAt: '2000-01-01T09:00:00-03:00' };
    expect(slotSchema.parse(pastSlot)).toEqual(pastSlot);
  });

  it('restringe reservas e encaminhamentos aos estados previstos pelo MVP', () => {
    expect(trialClassSchema.safeParse({ ...booking, status: 'pending' }).success).toBe(false);
    expect(handoffSchema.safeParse({ ...handoff, status: 'connected' }).success).toBe(false);
  });
});
