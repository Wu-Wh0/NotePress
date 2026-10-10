---
fixture: SIMULATED
category: synthetic-only
private_marker: FRONTMATTER_ONLY_7842
banner: "![[not-a-body-image.png]]"
---

# SIMULATED 综合测试文章

这是一篇完全合成的文章，用来检查中文、English punctuation: commas, semicolons; 还有 emoji 🧪🌈。**粗体**、*斜体*和~~删除线~~都应保留。

价格为 $12.50，续费 $30.00；字面转义美元写作 \$45。链接标签中的价格是[套餐 $12.50](https://example.test/catalog?price=%2412.50)，另有[公式 $x^2$](https://example.test/math)。

行内公式 $x^2+\frac{a}{b}+\alpha$ 与价格同处一篇文章。下面是分式、矩阵和希腊字母组成的块公式：

$$
\frac{1}{2}\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}+\beta
$$

> 引用中的**强调**、$y+1$ 和中文标点：甲，乙。
>
> 第二行仍是引用。

1. 第一项
   - 嵌套项目甲
   - 嵌套项目乙
2. 第二项

- [x] 已完成的合成任务
- [ ] 待完成的合成任务

| 项目 | 数值 | 备注 |
| --- | --- | --- |
| 面积 | $x^2$ | 转义管道 A \| B |
| 价格 | $30.00 | 简短说明 |

| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 合成一 | 合成二 | 合成三 | 合成四 | 合成五 | 合成六 | 合成七 | 合成八 |

围栏代码中的 HTML 与美元都是字面文本：

```html
<div data-price="$12.50">SIMULATED</div>
```

行内代码 `<span>$30.00</span>` 和 `const price = "$12.50";` 也应保留。下方单行代码刻意较长但有界：

```text
SIMULATED_GRID_ROW_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_END
```

长链接：[合成资料页](https://example.test/archive/synthetic/section/abcdefghijklmnopqrstuvwxyz0123456789/abcdefghijklmnopqrstuvwxyz0123456789/abcdefghijklmnopqrstuvwxyz0123456789?mode=preview&source=fixture)。

普通图片：![彩色网格](synthetic-grid.png)

Obsidian 图片：![[synthetic-grid.png|320]]

显式显示文字的笔记链接：[[Synthetic/Unopened-Target-7392.md|合成显示文字]]。这里只转换显示文字，不读取目标。
