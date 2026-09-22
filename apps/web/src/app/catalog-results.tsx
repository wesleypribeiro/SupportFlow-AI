import type { LanguageSchoolToolResult } from '@supportflow/contracts/language-school';

type CatalogResult = Extract<LanguageSchoolToolResult, {
  tool: 'get_school_info' | 'get_courses' | 'get_course_details';
}>;

function CatalogResultCard({ entry }: { entry: CatalogResult }) {
  if (!entry.result.ok) {
    return <p className="result-notice">{entry.result.error.code === 'NOT_FOUND'
      ? 'Este curso não está disponível. Pergunte por outra opção.'
      : 'Não foi possível consultar esses dados. Tente reformular sua pergunta.'}</p>;
  }
  switch (entry.tool) {
    case 'get_school_info': {
      const { school } = entry.result.data;
      return (
        <article className="result-card" aria-label="Sobre a escola">
          <p className="eyebrow">Conheça a escola</p>
          <h3>{school.name}</h3><p>{school.description}</p>
          <dl className="school-facts">
            <div><dt>Endereço</dt><dd>{school.address}</dd></div>
            <div><dt>Contato</dt><dd>{school.contact}</dd></div>
            <div><dt>Funcionamento</dt><dd>{school.openingHours}</dd></div>
          </dl>
        </article>
      );
    }
    case 'get_courses': {
      const { courses } = entry.result.data;
      return (
        <section aria-label="Cursos disponíveis">
          <p className="eyebrow">Explore os cursos</p>
          {courses.length === 0 ? <p className="result-notice">Nenhum curso disponível no momento.</p> : (
            <ul className="course-list">
              {courses.map((course) => (
                <li key={course.id} className="course-card">
                  <span className="course-language">{course.language}</span>
                  <h3>{course.name}</h3>
                  <span className="modality">{course.modality === 'online' ? 'Online' : 'Presencial'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    }
    case 'get_course_details': {
      const { course } = entry.result.data;
      return (
        <article className="result-card course-detail" aria-label="Detalhes do curso">
          <p className="eyebrow">Sobre o curso</p><h3>{course.name}</h3>
          <p className="course-meta">{course.language} · {course.modality === 'online' ? 'Online' : 'Presencial'}</p>
          <p>{course.description}</p>
          {course.price === null ? <p className="price-unavailable">Preço não informado</p> : (
            <p className="price" aria-label="Preço informado pela escola">
              <strong>{new Intl.NumberFormat('pt-BR', {
                style: 'currency', currency: course.price.currency,
              }).format(course.price.amountCents / 100)}</strong>
              <span>{course.price.billingPeriod === 'month' ? 'por mês' : 'por curso'}</span>
            </p>
          )}
        </article>
      );
    }
  }
}

export function CatalogResults({ results }: { results: LanguageSchoolToolResult[] }) {
  const catalog = results.filter((entry): entry is CatalogResult =>
    entry.tool === 'get_school_info' || entry.tool === 'get_courses' || entry.tool === 'get_course_details');
  if (catalog.length === 0) return null;
  return (
    <section className="catalog-results" aria-label="Informações da escola">
      <p className="official-label"><span aria-hidden="true">↳</span> Informações da escola</p>
      {catalog.map((entry, index) => <CatalogResultCard key={`${entry.tool}-${index}`} entry={entry} />)}
    </section>
  );
}
