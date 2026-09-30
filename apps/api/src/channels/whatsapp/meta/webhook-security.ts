import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const handshakeSchema = z.strictObject({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string().min(1),
});

type HandshakeResult = { status: 200; challenge: string } | { status: 400 | 403 };

function equalBytes(expected: Buffer, received: Buffer) {
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function verifyWebhookHandshake(query: unknown, verifyToken: string, rawQuery = ''): HandshakeResult {
  // O parser de query pode tolerar escapes inválidos; não aceitar essa ambiguidade.
  try {
    decodeURIComponent(rawQuery);
  } catch {
    return { status: 400 };
  }
  const parsed = handshakeSchema.safeParse(query);
  if (!parsed.success) return { status: 400 };

  const validToken = equalBytes(Buffer.from(verifyToken, 'utf8'), Buffer.from(parsed.data['hub.verify_token'], 'utf8'));
  if (parsed.data['hub.mode'] !== 'subscribe' || !validToken) return { status: 403 };
  return { status: 200, challenge: parsed.data['hub.challenge'] };
}

export function verifyWebhookSignature(body: Buffer, signature: unknown, appSecret: string): boolean {
  // Comprimento exato também exclui newline final (que o $ de uma regex tolera).
  if (typeof signature !== 'string' || signature.length !== 71 || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    return false;
  }
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(body).digest();
  return equalBytes(expected, received);
}
