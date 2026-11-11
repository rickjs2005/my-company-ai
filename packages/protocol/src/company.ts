// Identidade: o nome do PRODUTO é fixo ("My Company AI"); o nome da EMPRESA é escolhido por quem instala e fica em
// settings.companyName (SQLite, tabela settings). Tudo que mostra ou cita o nome lê daqui: interface, título da aba e
// contexto dos agentes. Perfis editoriais, equipes, clientes e contas sociais são outras entidades e não mudam junto.
// Identificadores internos (pacotes @milweb-hq/*, MILWEB_HQ_PORT, %LOCALAPPDATA%\MilWebHQ, tarefa agendada) continuam
// os de antes, por compatibilidade com instalações existentes.

/** Nome fixo do produto (aplicativo). Não é o nome da empresa de ninguém. */
export const PRODUCT_NAME = 'My Company AI';

/** Limite do nome da empresa, em caracteres depois da normalização. */
export const COMPANY_NAME_MAX = 60;

export type CompanyNameCheck = { ok: true; name: string } | { ok: false; error: string };

function isForbiddenCodePoint(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

/**
 * Normaliza e valida o nome da empresa (mesma regra no navegador e no servidor): tira espaços das pontas, junta
 * espaços repetidos, aceita acentos e qualquer alfabeto, recusa vazio, caractere de controle e nome longo demais.
 */
export function checkCompanyName(raw: unknown): CompanyNameCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Informe o nome da empresa.' };
  const normalized = raw.normalize('NFC');
  // Tab e quebra de linha viram espaço; outros caracteres de controle, separadores de linha e marcas de direção
  // invisíveis não entram num nome.
  const spaced = normalized.replace(/[\t\n\r]/g, ' ');
  if ([...spaced].some(ch => isForbiddenCodePoint(ch.codePointAt(0) ?? 0))) return { ok: false, error: 'O nome tem caracteres que não podem ser usados.' };
  const name = spaced.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Informe o nome da empresa.' };
  if ([...name].length > COMPANY_NAME_MAX) return { ok: false, error: `O nome pode ter até ${COMPANY_NAME_MAX} caracteres.` };
  return { ok: true, name };
}

/** Nome configurado, ou null quando a instalação ainda não escolheu (primeiro acesso). */
export function configuredCompanyName(settings: { companyName?: string | null } | null | undefined): string | null {
  const n = settings?.companyName;
  return typeof n === 'string' && n.trim() ? n : null;
}

/** Nome para exibir: o da empresa; sem nome escolhido, o do produto. */
export function companyDisplayName(settings: { companyName?: string | null } | null | undefined): string {
  return configuredCompanyName(settings) ?? PRODUCT_NAME;
}

/** Título da aba do navegador: "Aurora Social · My Company AI" (só o produto enquanto não há nome). */
export function documentTitle(settings: { companyName?: string | null } | null | undefined): string {
  const n = configuredCompanyName(settings);
  return n ? `${n} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}

/**
 * Como os agentes ouvem o nome da empresa em que trabalham. Com nome: "Aurora Social (empresa de social media que
 * opera no aplicativo My Company AI)". Sem nome: "uma empresa de social media que opera no aplicativo My Company AI".
 */
export function companyForAgents(settings: { companyName?: string | null } | null | undefined): string {
  const n = configuredCompanyName(settings);
  return n ? `${n} (empresa de social media que opera no aplicativo ${PRODUCT_NAME})` : `uma empresa de social media que opera no aplicativo ${PRODUCT_NAME}`;
}
