// Pastas temporárias dos testes: todas são apagadas ao fim do arquivo de teste (antes ficavam em %TEMP%; eram 466 em 01/11/2026).
// rmSync não segue links/junctions (usa lstat): apaga o link, não o destino.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

export function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

after(() => {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* arquivo preso por processo ainda saindo: o próximo teste não depende disto */ }
  }
});
