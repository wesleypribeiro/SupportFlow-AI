// Contratos internos de transporte. Não representam entrega nem autorização.
// O adapter meta/cloud-api-client.ts valida os limites de meta/compatibility.md.
export type WhatsAppMessage = Readonly<{
  type: 'text';
  body: string;
}> | Readonly<{
  type: 'reply_buttons';
  body: string;
  buttons: readonly Readonly<{ id: string; title: string }>[];
}>;

export type WhatsAppSendRequest = Readonly<{
  // Identificador opaco; não é contato do lead nem telefone civil validado.
  recipientId: string;
  message: WhatsAppMessage;
}>;

export type WhatsAppSendResult = Readonly<{
  status: 'accepted';
  messageId: string;
}> | Readonly<{
  status: 'rejected';
  // Categoria local sanitizada; nunca corpo/erro bruto do provedor.
  reason: 'invalid_request' | 'unauthorized' | 'rate_limited' | 'provider_rejection';
}> | Readonly<{
  status: 'unknown';
  reason: 'timeout' | 'network_error' | 'invalid_response';
}>;

export interface WhatsAppTransport {
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
}
