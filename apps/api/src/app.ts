import { loadCoreConfig } from './core/config.js';
import { createServer } from './core/server.js';
import { loadLanguageSchoolConfig } from './modules/language-school/config.js';
import { courseFixtures, schoolFixture } from './modules/language-school/infrastructure/catalog-fixtures.js';
import { createCatalogTools } from './modules/language-school/infrastructure/catalog-tools.js';
import { InMemorySchoolRepository } from './modules/language-school/infrastructure/in-memory-school-repository.js';

// Composição explícita: o core não importa nem escolhe o segmento da aplicação.
export function createApplication(environment: NodeJS.ProcessEnv) {
  const config = {
    ...loadCoreConfig(environment),
    school: loadLanguageSchoolConfig(environment),
  };

  if (config.school.schoolId !== schoolFixture.id) {
    throw new Error('SCHOOL_ID não corresponde à escola cadastrada nesta demonstração.');
  }

  const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const catalogTools = createCatalogTools(schoolRepository);

  return { server: createServer(), config, catalogTools };
}
