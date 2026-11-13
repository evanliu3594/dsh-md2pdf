无前言的文档

标题层级从一级开始，没有 frontmatter 块。

## 长表格

| 序号 | 名称 | 说明文字 | 备注 |
|---:|---|---|---|
| 1 | 栅格重采样 | 用最近邻法把 0.1 度格点聚合到 2 度格点，保留总量守恒 | 需要按面积加权 |
| 2 | 人口加权 | 按受体国人口分布对浓度加权，避免简单平均 | 与 GBD 口径一致 |
| 3 | 归因计算 | 用相对风险函数积分得到归因死亡人数 | 置信区间按 1000 次抽样 |

## 深层嵌套

1. 第一层
   - 第二层项目
     1. 第三层有序
        - 第四层无序
          - 第五层，验证缩进递归
2. 回到第一层

> 引用里放列表：
>
> - 项目甲
> - 项目乙
>
> 引用结束后继续正文。

## 宽代码

```python
def weighted_mean(concentration, population, weights):
    numerator = sum(c * p * w for c, p, w in zip(concentration, population, weights))
    denominator = sum(p * w for p, w in zip(population, weights))
    return numerator / denominator
```

## 未闭合的围栏

```text
这一行的围栏没有闭合，渲染器应当把余下内容都当作代码。
