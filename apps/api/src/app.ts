import { loadCoreConfig } from './core/config.js';
import { createServer } from './core/server.js';
import { loadLanguageSchoolConfig } from './modules/language-school/config.js';

// Composição explícita: o core não importa nem escolhe o segmento da aplicação.
export function createApplication(environment: NodeJS.ProcessEnv) {
  const config = {
    ...loadCoreConfig(environment),
    school: loadLanguageSchoolConfig(environment),
  };

  return { server: createServer(), config };
}
