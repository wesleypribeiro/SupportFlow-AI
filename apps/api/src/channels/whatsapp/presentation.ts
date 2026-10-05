// Limites registrados em meta/compatibility.md. A contagem em unidades UTF-16
// é conservadora; a divisão preserva Unicode e inclui a numeração no limite.
export const WHATSAPP_TEXT_LIMIT = 4096;
export const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;

function partition(text: string, capacity: number): string[] {
  const parts: string[] = [];
  let pending = '';
  let newlineBoundary = 0;
  let whitespaceBoundary = 0;
  const append = (segment: string) => {
    while (pending.length + segment.length > capacity) {
      // Preferir linhas completas mantém preços, datas, contatos e IDs juntos.
      // Em prosa longa, usar palavras; sem separadores, preservar grafemas.
      const boundary = newlineBoundary || whitespaceBoundary || pending.length;
      parts.push(pending.slice(0, boundary));
      pending = pending.slice(boundary);
      newlineBoundary = Math.max(0, newlineBoundary - boundary);
      whitespaceBoundary = Math.max(0, whitespaceBoundary - boundary);
    }
    pending += segment;
    // Só registrar fronteiras após o grafema inteiro, inclusive em whitespace
    // seguido de marcas combinantes; uma regex sobre pending poderia cortá-lo.
    if (segment.includes('\n')) newlineBoundary = pending.length;
    if (/^\s+$/u.test(segment)) whitespaceBoundary = pending.length;
  };
  for (const { segment } of new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(text)) {
    // Um grafema patológico pode sozinho exceder uma mensagem (p.ex. milhares
    // de marcas combinantes). Nesse caso preservar cada ponto de código.
    if (segment.length > capacity) {
      for (const codePoint of segment) append(codePoint);
    } else append(segment);
  }
  if (pending) parts.push(pending);
  return parts;
}

export function splitWhatsAppText(text: string): string[] {
  if (!text) return [];
  if (text.length <= WHATSAPP_TEXT_LIMIT) return [text];
  let total = 2;
  for (;;) {
    const capacity = WHATSAPP_TEXT_LIMIT - `[${total}/${total}]\n`.length;
    const parts = partition(text, capacity);
    if (parts.length === total) {
      return parts.map((part, index) => `[${index + 1}/${total}]\n${part}`);
    }
    total = parts.length;
  }
}
