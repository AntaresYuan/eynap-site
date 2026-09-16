/**
 * 翻译输出清洗与语种判定的边界测试。
 * 换成指令模型后，分句/占位符那套补丁已删除，测试相应收敛。
 */
import { sanitizeName, fixAfterTranslate, guessLang, cleanOutput,
         isHallucination, needsTranslation } from './index.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? '→ ' + extra : ''); }
};

// ───────── 输出清洗 ─────────
console.log('\n输出清洗（指令模型的常见杂质）：');

const src = 'The skill split is clean.';

ok(cleanOutput('技能拆分很清晰。', src) === '技能拆分很清晰。', '干净输出原样通过');
ok(cleanOutput('  技能拆分很清晰。  ', src) === '技能拆分很清晰。', '首尾空白被去掉');
ok(cleanOutput('Here is the translation: 技能拆分很清晰。', src) === '技能拆分很清晰。',
   '英文前言被去掉', cleanOutput('Here is the translation: 技能拆分很清晰。', src));
ok(cleanOutput("Here's the translation：技能拆分很清晰。", src) === '技能拆分很清晰。',
   '缩写式前言被去掉');
ok(cleanOutput('译文：技能拆分很清晰。', src) === '技能拆分很清晰。', '中文前言被去掉');
ok(cleanOutput('翻译: 技能拆分很清晰。', src) === '技能拆分很清晰。', '「翻译:」前言被去掉');
ok(cleanOutput('"技能拆分很清晰。"', src) === '技能拆分很清晰。', '包裹的双引号被去掉');
ok(cleanOutput('「技能拆分很清晰。」', src) === '技能拆分很清晰。', '中文书名号被去掉');
ok(cleanOutput('', src) === '', '空串返回空串');
ok(cleanOutput(null, src) === '', 'null 返回空串');
ok(cleanOutput(undefined, src) === '', 'undefined 返回空串');

// 模型把原文一起带回来
const withSrc = cleanOutput(src + ' 技能拆分很清晰。', src);
ok(!withSrc.includes(src) && withSrc.includes('技能拆分'),
   '原文被一起返回时只留译文', withSrc);

// 译文里正好包含原文片段时不能误删
ok(cleanOutput('技能拆分很清晰。', '清晰') === '技能拆分很清晰。',
   '译文含原文片段但长度接近时不误删',
   cleanOutput('技能拆分很清晰。', '清晰'));

// 引号只有一边不该乱切
ok(cleanOutput('"引号只有开头', src) === '"引号只有开头', '单边引号保持原样');

// ───────── 语种判定 ─────────
console.log('\n语种判定：');

ok(guessLang('全是中文的一句话') === 'zh', '纯中文');
ok(guessLang('All English here') === 'en', '纯英文');
ok(guessLang('') === 'und', '空串判为未知（而非默认英文，避免白翻）');
ok(guessLang('pm-prd pm-entity SKILL.md') === 'en', '纯术语判为英文');
ok(guessLang('用 pm-prd 写 PRD 文档很顺手') === 'zh', '中文夹术语仍判中文');
ok(guessLang('The pm-prd skill 很好用') === 'en', '英文为主夹少量中文判英文');
ok(guessLang('123 456 !!!') === 'und', '纯符号数字判为未知');
ok(guessLang('好') === 'zh', '单个汉字');

// 非中英语言：界面只有中英，但评价可能是任何语言
ok(guessLang('日本語のレビューです') === 'ja', '日语（假名）');
ok(guessLang('このpm-prdは使いやすい') === 'ja',
   '日语夹汉字不被误判为中文', guessLang('このpm-prdは使いやすい'));
ok(guessLang('한국어 리뷰입니다') === 'ko', '韩语');
ok(guessLang('Очень полезный инструмент') === 'ru', '俄语');
ok(guessLang('هذه أداة مفيدة') === 'ar', '阿拉伯语');
ok(guessLang('สวัสดีครับ') === 'th', '泰语');
ok(guessLang('Très utile, je recommande') === 'eur', '带变音符的欧洲语言');
ok(guessLang('Sehr nützlich für das Team') === 'eur', '德语（含 ü）');
ok(guessLang('👍👍👍') === 'und', '纯 emoji 判为未知');
ok(guessLang('12345 !!!') === 'und', '纯数字标点判为未知');

// ───────── 是否需要翻译 ─────────
console.log('\n翻译判定：');

ok(needsTranslation('en', 'zh'), '英文评价 + 中文界面 → 翻');
ok(needsTranslation('zh', 'en'), '中文评价 + 英文界面 → 翻');
ok(needsTranslation('ja', 'zh'), '日语评价 + 中文界面 → 翻');
ok(needsTranslation('ja', 'en'), '日语评价 + 英文界面 → 翻');
ok(needsTranslation('ru', 'zh'), '俄语评价 + 中文界面 → 翻');
ok(needsTranslation('eur', 'en'), '欧洲语言 + 英文界面 → 翻');
ok(!needsTranslation('zh', 'zh'), '同语种不翻');
ok(!needsTranslation('en', 'en'), '同语种不翻（英）');
ok(!needsTranslation('und', 'zh'), '语种未知不翻，不浪费额度');
ok(!needsTranslation('und', 'en'), '语种未知不翻（英界面）');
ok(!needsTranslation('', 'zh'), '空语种不翻');

// ───────── 译后补词 ─────────
console.log('\n译后补词：');

ok(fixAfterTranslate('orchestrator 决定阶段', 'zh').includes('编排器'),
   '未译的 orchestrator 被补上', fixAfterTranslate('orchestrator 决定阶段', 'zh'));
ok(fixAfterTranslate('不运行整个 pipeline', 'zh').includes('流水线'),
   '未译的 pipeline 被补上');
ok(fixAfterTranslate('管弦乐队决定阶段', 'zh').includes('编排器'),
   '错译的「管弦乐队」被纠正');
ok(fixAfterTranslate('我可以拨打 pm-prd', 'zh').includes('调用'),
   '错译的「拨打」被纠正');
ok(fixAfterTranslate('正常的中文句子', 'zh') === '正常的中文句子', '无需修正时不改动');
ok(fixAfterTranslate('', 'zh') === '', '空串不崩');
ok(typeof fixAfterTranslate('anything', 'ja') === 'string', '未知目标语言不崩');
// 词边界：不能误伤包含目标词的更长单词
ok(fixAfterTranslate('orchestrators are here', 'en') === 'orchestrators are here',
   '不误伤复数形式等更长的词',
   fixAfterTranslate('orchestrators are here', 'en'));

// ───────── 幻觉防护 ─────────
console.log('\n幻觉防护：');

ok(isHallucination(
   '我们收到了有关PM-PRD的反馈，内容是关于SKILL.md文件中缺少了技能树的详细描述。',
   'One sentence only', 'zh', 'en'), '短原文被扩写成长段落 → 判为幻觉');
ok(!isHallucination('只有一个句子', 'One sentence only', 'zh', 'en'), '正常英译中不误判');
ok(!isHallucination(
   'The skill split is clean and I can call pm-prd alone without the pipeline.',
   '拆分很清楚，我可以单独调用 pm-prd，不用跑整条流水线。', 'en', 'zh'),
   '正常中译英（会变长）不误判');
ok(!isHallucination('Great! Really useful. Would recommend.', '很棒！真有用。推荐。', 'en', 'zh'),
   '短中文译英膨胀不误判');
ok(!isHallucination('It is very clear and easy to get started.', '拆分很清楚，上手快。', 'en', 'zh'),
   '短中文译英（4 倍长）不误判');
// 日韩同属高密度书写，阈值要和中文一致
ok(!isHallucination('It was very convenient and easy to use.',
   'とても便利でした。', 'en', 'ja'), '日译英膨胀不误判');
ok(!isHallucination('这是一条日语评价，非常方便。',
   '日本語のレビューです。とても便利でした。', 'zh', 'ja'), '日译中不误判');
// 疏→疏：俄译英长度相当，阈值更紧
ok(isHallucination('A'.repeat(200), 'Очень полезный инструмент.', 'en', 'ru'),
   '俄译英长度暴涨判为幻觉');
ok(!isHallucination('A very useful tool for the team.',
   'Очень полезный инструмент для команды.', 'en', 'ru'), '俄译英正常不误判');
ok(isHallucination('', 'anything', 'zh', 'en'), '空译文判为失败');
ok(isHallucination('x', '这是一段二十个字以上的中文原文内容用于测试比例下限', 'en', 'zh'),
   '译文过短判为幻觉');
ok(!isHallucination('好', '好的', 'zh', 'en'), '极短原文不做下限判断');

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
ok(sanitizeName('Quiet\nOtter extra line') === null, '多行整体被拒');
ok(sanitizeName('<script>alert(1)</script>') === null, '标签被拒');
ok(sanitizeName("'; DROP TABLE reviews;--") === null, 'SQL 片段被拒');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
