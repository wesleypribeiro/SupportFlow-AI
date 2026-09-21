import Fastify from 'fastify';

export function createServer() {
  const server = Fastify();

  server.get('/health', async () => ({ status: 'ok' }));

  return server;
}
