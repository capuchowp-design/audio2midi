// scripts/patch-android.mjs
// Ajusta o projeto ./android gerado por `npx cap add android` (que não é versionado):
//   1. AndroidManifest: permissões de microfone, allowBackup=false
//   2. app/build.gradle: versionCode/versionName e assinatura "release" (via variáveis de ambiente)
//   3. gradle.properties: mais memória para o Gradle
//   4. file_paths.xml: FileProvider liberando o cache (necessário para compartilhar o .mid)
//   5. Ícones do app (adaptativo + legado), gerados aqui mesmo, sem dependências
// É idempotente: pode rodar várias vezes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const ANDROID = path.join(ROOT, 'android');
const APP = path.join(ANDROID, 'app');
const RES = path.join(APP, 'src', 'main', 'res');
const MANIFEST = path.join(APP, 'src', 'main', 'AndroidManifest.xml');
const BUILD_GRADLE = path.join(APP, 'build.gradle');
const GRADLE_PROPS = path.join(ANDROID, 'gradle.properties');

function fail(msg) { console.error('ERRO: ' + msg); process.exit(1); }
if (!fs.existsSync(ANDROID)) fail('pasta android/ não existe. Rode `npx cap add android` antes.');
for (const f of [MANIFEST, BUILD_GRADLE]) if (!fs.existsSync(f)) fail('arquivo esperado não encontrado: ' + f);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ 1) Manifest */
{
  let xml = fs.readFileSync(MANIFEST, 'utf8');
  const wanted = [
    '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
    '<uses-feature android:name="android.hardware.microphone" android:required="false" />'
  ];
  const toAdd = wanted.filter((line) => {
    const key = line.match(/android:name="([^"]+)"/)[1];
    return !xml.includes(key);
  });
  if (toAdd.length) {
    if (!xml.includes('<application')) fail('tag <application> não encontrada no AndroidManifest.xml');
    xml = xml.replace('<application', toAdd.join('\n    ') + '\n\n    <application');
  }
  xml = xml.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
  fs.writeFileSync(MANIFEST, xml);
  console.log('[manifest] permissões de microfone OK' + (toAdd.length ? ' (+' + toAdd.length + ')' : ' (já presentes)'));
}

/* ------------------------------------------------------------------ 2) build.gradle */
{
  const MARK = '// >>> audiomidi-patch';
  let gradle = fs.readFileSync(BUILD_GRADLE, 'utf8');
  const versionCode = parseInt(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || '1', 10) || 1;
  const versionName = process.env.VERSION_NAME || pkg.version || '1.0.0';

  // remove bloco anterior (idempotência)
  const start = gradle.indexOf(MARK);
  if (start >= 0) gradle = gradle.slice(0, start).trimEnd() + '\n';

  gradle += `
${MARK}
// Blocos "android { }" adicionais são mesclados ao principal pelo Gradle.
android {
    defaultConfig {
        versionCode = ${versionCode}
        versionName = "${versionName}"
    }
}

def audiomidiKeystore = file('release.keystore')
def audiomidiStorePass = System.getenv('KEYSTORE_PASSWORD')
if (audiomidiKeystore.exists() && audiomidiStorePass) {
    android {
        signingConfigs {
            release {
                storeFile = audiomidiKeystore
                storePassword = audiomidiStorePass
                keyAlias = System.getenv('KEY_ALIAS') ?: 'audiomidi'
                keyPassword = System.getenv('KEY_PASSWORD') ?: audiomidiStorePass
            }
        }
        buildTypes {
            release {
                signingConfig = signingConfigs.release
            }
        }
    }
    println 'audiomidi: assinatura release ATIVADA'
} else {
    println 'audiomidi: sem keystore/senha -> release NÃO será assinado (use assembleDebug)'
}
// <<< audiomidi-patch
`;
  fs.writeFileSync(BUILD_GRADLE, gradle);
  console.log('[gradle] versionCode=' + versionCode + ' versionName=' + versionName + ' + assinatura release');
}

/* ------------------------------------------------------------------ 3) gradle.properties */
{
  let props = fs.existsSync(GRADLE_PROPS) ? fs.readFileSync(GRADLE_PROPS, 'utf8') : '';
  const line = 'org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8';
  if (/^org\.gradle\.jvmargs=.*$/m.test(props)) props = props.replace(/^org\.gradle\.jvmargs=.*$/m, line);
  else props += (props.endsWith('\n') || !props ? '' : '\n') + line + '\n';
  fs.writeFileSync(GRADLE_PROPS, props);
  console.log('[gradle.properties] jvmargs OK');
}

/* ------------------------------------------------------------------ 4) FileProvider */
{
  const dir = path.join(RES, 'xml');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'file_paths.xml'), `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <external-path name="my_images" path="." />
    <cache-path name="my_cache_images" path="." />
    <files-path name="my_files" path="." />
</paths>
`);
  console.log('[xml] file_paths.xml OK (cache liberado para compartilhar .mid)');
}

/* ------------------------------------------------------------------ 5) Ícones */
// PNG mínimo (RGBA 8 bits) sem dependências
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [0x0b, 0x0d, 0x14, 255], CY = [0x22, 0xd3, 0xee, 255], MG = [0xe8, 0x79, 0xf9, 255], AM = [0xfb, 0xbf, 0x24, 255];
// geometria do ícone numa grade de 512 (a mesma do icon.svg)
const WAVE = [[76, 226, 286], [120, 176, 336], [164, 126, 386], [208, 166, 346], [252, 206, 306]]; // x, y0, y1 (largura 28)
const NOTES = [[310, 150, 396, CY], [350, 206, 436, MG], [300, 262, 372, MG], [380, 318, 440, AM]];  // x0, y, x1 (altura 36)

function renderIcon(size, { background, scale, circle }) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, r = size / 2;
  if (background) for (let i = 0; i < size * size; i++) px.set(background, i * 4);
  const k = size / 512;
  const T = (v) => Math.round((256 + (v - 256) * scale) * k);
  const rect = (x0, y0, x1, y1, color) => {
    for (let y = Math.max(0, T(y0)); y < Math.min(size, T(y1)); y++)
      for (let x = Math.max(0, T(x0)); x < Math.min(size, T(x1)); x++) px.set(color, (y * size + x) * 4);
  };
  for (const [x, y0, y1] of WAVE) rect(x, y0, x + 28, y1, CY);
  for (const [x0, y, x1, c] of NOTES) rect(x0, y, x1, y + 36, c);
  if (circle) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cx;
      if (dx * dx + dy * dy > r * r) px[(y * size + x) * 4 + 3] = 0;
    }
  }
  return encodePng(size, size, px);
}

{
  const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const d of Object.keys(LEGACY)) {
    const dir = path.join(RES, 'mipmap-' + d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderIcon(LEGACY[d], { background: BG, scale: 1, circle: false }));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), renderIcon(LEGACY[d], { background: BG, scale: 1, circle: true }));
    // primeiro plano adaptativo: transparente, arte reduzida para caber na zona segura (~61%)
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), renderIcon(ADAPTIVE[d], { background: null, scale: 0.78, circle: false }));
  }
  const any = path.join(RES, 'mipmap-anydpi-v26');
  fs.mkdirSync(any, { recursive: true });
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  fs.writeFileSync(path.join(any, 'ic_launcher.xml'), adaptive);
  fs.writeFileSync(path.join(any, 'ic_launcher_round.xml'), adaptive);
  fs.mkdirSync(path.join(RES, 'values'), { recursive: true });
  fs.writeFileSync(path.join(RES, 'values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0B0D14</color>
</resources>
`);
  // evita conflito com vetores antigos de templates mais velhos
  for (const old of ['drawable-v24/ic_launcher_foreground.xml', 'drawable/ic_launcher_background.xml']) {
    const f = path.join(RES, old);
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  console.log('[ícones] launcher legado + adaptativo gerados');
}

console.log('patch-android concluído.');
