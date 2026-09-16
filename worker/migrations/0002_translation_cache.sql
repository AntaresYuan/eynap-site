-- 评价译文缓存
-- 同一条评价只调一次翻译模型，之后直接读这两列。
-- 留空表示还没翻过；原文本身就是目标语言时不写入，接口直接回原文。

ALTER TABLE reviews ADD COLUMN trans_zh TEXT;
ALTER TABLE reviews ADD COLUMN trans_en TEXT;
