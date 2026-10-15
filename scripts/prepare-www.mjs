// scripts/prepare-www.mjs
// Copia os arquivos da PWA para ./www (webDir do Capacitor).
// O service worker (sw.js) NÃO entra no APK: lá os arquivos já ficam embutidos no app.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'www');

const FILES = [
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon.svg',
  'privacy.html'
];

const missing = FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error('ERRO: arquivos ausentes na raiz do projeto: ' + missing.join(', '));
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  console.log('  copiado -> www/' + f);
}
console.log('www/ pronto (' + FILES.length + ' arquivos).');
