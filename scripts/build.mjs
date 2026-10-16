#!/usr/bin/env node
// src/를 출력 폴더로 복사하고 사이트 주소 자리표시를 SITE_URL로 바꾼다.
// 사용법: SITE_URL=https://example.com node scripts/build.mjs [출력 폴더]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'https://site-url.invalid';
const TEXT = /\.(html|txt|xml|json|svg|css|js|webmanifest)$/;

export function build(outDir, site = '') {
  site = site.replace(/\/+$/, '');
  if (site && !/^https?:\/\/[^/\s]+(\/[\w.-]+)*$/.test(site)) throw new Error(`사이트 주소 형식 오류: ${site}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync('src', outDir, { recursive: true });
  if (site) {
    for (const file of fs.readdirSync(outDir, { recursive: true })) {
      const full = path.join(outDir, file);
      if (!TEXT.test(file) || !fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(PLACEHOLDER)) fs.writeFileSync(full, text.replaceAll(PLACEHOLDER, site));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] ?? '_site');
  const site = process.env.SITE_URL ?? '';
  build(outDir, site);
  if (!site) console.log(`SITE_URL이 없어 사이트 주소를 ${PLACEHOLDER}로 둡니다`);
  console.log(`빌드 완료: ${path.relative(process.cwd(), outDir)}/`);
}
