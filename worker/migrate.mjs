/** 把 data/store.json 里已有的评价导出成 D1 可执行的 SQL。 */
import { readFileSync, writeFileSync } from 'node:fs';

const store = JSON.parse(readFileSync(new URL('../data/store.json', import.meta.url), 'utf8'));
const q = s => `'${String(s).replace(/'/g, "''")}'`;

const lines = ['-- 由 migrate.mjs 生成，勿手改'];
for (const r of [...store.reviews].reverse()) {   // 反转：让原有顺序在库里保持
  lines.push(
    `INSERT INTO reviews (author, text, feature, effect, stability, version, created_at) VALUES (` +
    `${q(r.author)}, ${q(r.text)}, ${r.feature}, ${r.effect}, ${r.stability}, ` +
    `${q(store.plugin.latestVersion)}, ${q(r.date + ' 00:00:00')});`
  );
}
if (store.downloads > 0) {
  lines.push(`UPDATE counters SET value = ${store.downloads} WHERE key = 'downloads';`);
}

writeFileSync(new URL('./seed.sql', import.meta.url), lines.join('\n') + '\n');
console.log(`已生成 seed.sql：${store.reviews.length} 条评价，下载数 ${store.downloads}`);
