/**
 * 翻译链路的边界测试：分句、术语保护、名字清洗。
 * 不联网、不调模型，专打容易出低级错误的边界。
 */
import { splitSentences, protectTerms, restoreTerms, sanitizeName,
         fixAfterTranslate, guessLang, joinSentences } from './index.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? '→ ' + extra : ''); }
};

// ───────── 分句 ─────────
console.log('\n分句边界：');

const sp = (t, l) => splitSentences(t, l);

ok(sp('One. Two. Three.', 'en').length === 3, '英文三句');
ok(sp('单句无标点', 'zh').length === 1, '中文无标点算一句');
ok(sp('', 'en').length === 0, '空字符串不产生空片段');
ok(sp('   ', 'en').length === 0, '纯空白不产生片段');
ok(sp('...', 'en').every(x => x.trim()), '连续句点不产生空片段');
ok(sp('。。。', 'zh').every(x => x.trim()), '连续中文句号不产生空片段');

// 小数点、缩写、版本号不该被误拆——这是最典型的分句陷阱
ok(sp('It costs 3.5 dollars.', 'en').length === 1,
   '小数点不误拆', JSON.stringify(sp('It costs 3.5 dollars.', 'en')));
ok(sp('Works on v2.0.0 fine.', 'en').length === 1,
   '版本号不误拆', JSON.stringify(sp('Works on v2.0.0 fine.', 'en')));
ok(sp('Read SKILL.md first.', 'en').length === 1,
   'SKILL.md 不误拆', JSON.stringify(sp('Read SKILL.md first.', 'en')));
ok(sp('e.g. this one.', 'en').length === 1,
   '缩写 e.g. 不误拆', JSON.stringify(sp('e.g. this one.', 'en')));
ok(sp('Ask Dr. Smith about it.', 'en').length === 1,
   '称谓 Dr. 不误拆', JSON.stringify(sp('Ask Dr. Smith about it.', 'en')));

// 拼回后内容不能丢
const roundTrip = (t, l, joiner) => sp(t, l).join(joiner);
ok(roundTrip('拆分清楚。上手快。', 'zh', '').replace(/\s/g,'')
   === '拆分清楚。上手快。'.replace(/\s/g,''), '中文拼回无损');
ok(roundTrip('First one. Second one.', 'en', ' ')
   === 'First one. Second one.', '英文拼回无损');

// 换行与超长
ok(sp('Line one.\nLine two.', 'en').length === 2, '换行分隔的两句');
ok(sp('a'.repeat(900) + '.', 'en').length === 1, '超长单句不崩');
ok(sp('问号？感叹号！分号；结束。', 'zh').length === 4, '中文四种标点都断句');
ok(sp('Why? Because! Yes.', 'en').length === 3, '英文问号叹号都断句');

// ───────── 术语保护 ─────────
console.log('\n术语保护：');

const rt = (text) => {
  const g = protectTerms(text);
  return restoreTerms(g.text, g.terms);
};

ok(rt('用 pm-prd 写文档') === '用 pm-prd 写文档', '单个术语可还原');
ok(rt('pm-prd 和 pm-entity 一起用') === 'pm-prd 和 pm-entity 一起用',
   '多个术语可还原', rt('pm-prd 和 pm-entity 一起用'));
ok(rt('pm-prd pm-prd pm-prd') === 'pm-prd pm-prd pm-prd',
   '同一术语重复出现', rt('pm-prd pm-prd pm-prd'));
ok(rt('没有任何术语的句子') === '没有任何术语的句子', '无术语时原样返回');
ok(rt('') === '', '空串不崩');

// 模型常见变形：占位符被加空格、改大小写
const g1 = protectTerms('call pm-prd now');
ok(restoreTerms(g1.text.replace('XQZ0ZQX', 'X Q Z 0 Z Q X'), g1.terms)
   === 'call pm-prd now', '占位符被加空格仍可还原');
ok(restoreTerms(g1.text.toLowerCase(), g1.terms).includes('pm-prd'),
   '占位符被转小写仍可还原',
   restoreTerms(g1.text.toLowerCase(), g1.terms));

// 占位符不能把正文里的普通字母吃掉
ok(!protectTerms('Quality matters').text.includes('XQZ'),
   '普通文本不产生占位符');

// 模型会啃掉占位符里的字符，实测出现过 XQZ0ZQX → XZ0ZQX
const dmg = protectTerms('Read SKILL.md first');
const tok = dmg.text.match(/[ZQ]+\d[ZQ]+/)[0];
ok(restoreTerms(dmg.text.replace(tok, tok.slice(1)), dmg.terms).includes('SKILL.md'),
   '占位符掉首字符仍能还原',
   restoreTerms(dmg.text.replace(tok, tok.slice(1)), dmg.terms));
ok(restoreTerms(dmg.text.replace(tok, tok.slice(0,-1)), dmg.terms).includes('SKILL.md'),
   '占位符掉尾字符仍能还原');
ok(restoreTerms(dmg.text.replace(tok, tok.slice(1,-1)), dmg.terms).includes('SKILL.md'),
   '占位符两端都掉仍能还原');
// 连数字都被改掉时，不能把乱码留给用户
const broken = restoreTerms(dmg.text.replace(tok, 'ZZQQZZ'), dmg.terms);
ok(!/[ZQ]{3,}/.test(broken), '彻底损坏时清掉残留而不是露出乱码', broken);

// 还原后术语两侧粘着没吃干净的字符（实测出现 SKILL.mdZ）
const tail = restoreTerms(dmg.text.replace(tok, tok + 'Z'), dmg.terms);
ok(/SKILL\.md(?![A-Za-z0-9])/.test(tail) && !/SKILL\.mdZ/.test(tail),
   '术语尾部粘的字符被清掉', tail);
const head = restoreTerms(dmg.text.replace(tok, 'Z' + tok), dmg.terms);
ok(!/ZSKILL/.test(head), '术语头部粘的字符被清掉', head);
// 但不能误伤正常单词
ok(restoreTerms('Quality Zone here', []) === 'Quality Zone here',
   '不误伤以 Z/Q 开头的正常单词');

// 术语是别的词的一部分时不该误伤
const partial = protectTerms('pm-prd-extra');
ok(restoreTerms(partial.text, partial.terms) === 'pm-prd-extra',
   '术语作为前缀出现仍能还原', restoreTerms(partial.text, partial.terms));

// ───────── 名字清洗 ─────────
console.log('\n名字清洗：');

ok(sanitizeName('Quiet Otter') === 'Quiet Otter', '正常两词通过');
ok(sanitizeName('  quiet otter  ') === 'Quiet Otter', '去空白并规范大小写');
ok(sanitizeName('"Swift Heron."') === 'Swift Heron', '去引号与句号');
ok(sanitizeName('QUIET OTTER') === 'Quiet Otter', '全大写被规范');
ok(sanitizeName('Agent 007') === null, '含数字被拒');
ok(sanitizeName('Quiet-Otter') === null, '含连字符被拒');
ok(sanitizeName('安静水獭') === null, '中文被拒');
ok(sanitizeName('Sure! Here is a handle for you') === null, '整句被拒');
ok(sanitizeName('') === null, '空串被拒');
ok(sanitizeName(null) === null, 'null 被拒');
ok(sanitizeName('ab') === null, '过短被拒');
ok(sanitizeName('Supercalifragilistic Expialidocious') === null, '过长被拒');
ok(sanitizeName('Otter') === 'Otter', '单词也接受');
ok(sanitizeName('Quiet\nOtter extra line') === null, '只取首行且首行不合规时拒绝',
   String(sanitizeName('Quiet\nOtter extra line')));
// 注入防护
ok(sanitizeName('<script>alert(1)</script>') === null, '标签被拒');
ok(sanitizeName("'; DROP TABLE reviews;--") === null, 'SQL 片段被拒');

// ───────── 语种判定 ─────────
console.log('\n语种判定：');

ok(guessLang('全是中文的一句话') === 'zh', '纯中文');
ok(guessLang('All English here') === 'en', '纯英文');
ok(guessLang('') === 'en', '空串默认英文');
ok(guessLang('pm-prd pm-entity SKILL.md') === 'en', '纯术语判为英文');
ok(guessLang('用 pm-prd 写 PRD 文档很顺手') === 'zh',
   '中文夹英文术语仍判中文');
ok(guessLang('The pm-prd skill 很好用') === 'en',
   '英文为主夹少量中文判英文', guessLang('The pm-prd skill 很好用'));
ok(guessLang('123 456 !!!') === 'en', '纯符号数字默认英文');

// ───────── 译后修正 ─────────
console.log('\n译后修正：');

ok(fixAfterTranslate('管弦乐队决定阶段', 'zh').includes('编排者'),
   'orchestrator 错译被纠正');
ok(fixAfterTranslate('我可以拨打pm-prd', 'zh').includes('调用'),
   'call 错译被纠正');
ok(fixAfterTranslate('整个管道', 'zh').includes('流水线'),
   'pipeline 错译被纠正');
ok(fixAfterTranslate('正常的中文句子', 'zh') === '正常的中文句子',
   '无需修正时不改动');
ok(fixAfterTranslate('', 'zh') === '', '空串不崩');
ok(typeof fixAfterTranslate('anything', 'ja') === 'string',
   '未知目标语言不崩');

// ───────── 拼接 ─────────
console.log('\n拼接：');

ok(joinSentences(['很棒','真的有用','会推荐'], 'zh') === '很棒。真的有用。会推荐。',
   '中文缺标点时补齐', joinSentences(['很棒','真的有用','会推荐'], 'zh'));
ok(joinSentences(['很棒。','真的有用。'], 'zh') === '很棒。真的有用。',
   '已有标点不重复补');
ok(joinSentences(['很棒!','有用'], 'zh') === '很棒！有用。',
   '半角标点转全角', joinSentences(['很棒!','有用'], 'zh'));
ok(joinSentences(['Great','Useful'], 'en') === 'Great. Useful.',
   '英文缺标点时补齐', joinSentences(['Great','Useful'], 'en'));
ok(joinSentences(['Great.','Useful.'], 'en') === 'Great. Useful.',
   '英文已有标点不重复补');
ok(joinSentences(['Why?','Yes!'], 'en') === 'Why? Yes!',
   '问号叹号不被覆盖');
ok(joinSentences([], 'zh') === '', '空数组返回空串');
ok(joinSentences(['', '  ', '有效'], 'zh') === '有效。', '空片段被滤掉');
ok(!joinSentences(['很棒','有用'], 'zh').includes(' '),
   '中文句间不留空格');
ok(joinSentences(['A','B'], 'en').includes(' '), '英文句间留空格');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
