# Módulo de escolas de idiomas

Nesta fundação, o módulo contém somente a configuração da escola única do processo.
O ponto de composição `src/app.ts` conecta essa configuração ao core, sem registro
dinâmico de segmentos ou seleção de escola pelo navegador.

As próximas tarefas criarão `domain/`, `application/` e `infrastructure/` conforme
o design aprovado. Entidades, repositórios, casos de uso e ferramentas ainda não
fazem parte deste milestone. O core não importa o módulo escolar.
