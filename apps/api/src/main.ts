import { createApplication } from './app.js';

try {
  const { server, config } = createApplication(process.env);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void server.close().catch(() => {
        console.error('Não foi possível encerrar a API.');
        process.exitCode = 1;
      });
    });
  }

  const address = await server.listen(config.http);
  console.info(`SupportFlow API disponível em ${address}`);
} catch {
  console.error('Não foi possível iniciar a API. Verifique a configuração e a porta.');
  process.exitCode = 1;
}
