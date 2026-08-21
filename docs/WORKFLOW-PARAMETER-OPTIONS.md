# 工作流参数下拉选项

本文记录 MerchRoute「系统设置 → 工作流配置 → 工作流参数」中已经启用下拉选择、且包含多个候选值的受控配置。配置于 2026-08-21 从本机运行中的 MerchRoute API 回读，并按界面中的实际顺序记录。

运行时配置文件保存在 MerchRoute 仓库之外；本文只记录不含凭据的字段名、当前默认值和可选值，不包含 API Key、Token、Cookie、数据库连接或 n8n 凭据。

## 生成 7 张套图（E003）

- 运行时参数文件：`E003_n8n_product_image_task.json`
- 下拉选项文件：`E003_n8n_product_image_task.options.json`

| 字段 | 当前默认值 | 已启用的下拉选项（按界面顺序） |
| --- | --- | --- |
| `Category` | `通用产品` | `通用产品`、`运动鞋`、`手提包`、`电吹风`、`家居收纳`、`锅具`、`小家电`、`台灯`、`上衣` |
| `targetPlatform` | `WB` | `WB`、`OZON`、`Yandex`、`Shopee`、`Amazon` |
| `ratio` | `3:4` | `3:4`、`1:1` |
| `Language` | `俄文` | `俄文`、`英文`、`越南语`、`法语`、`德语` |
| `Country` | `俄罗斯` | `俄罗斯`、`美国`、`越南`、`法国` |

对应的非敏感配置内容：

```json
{
  "parameters": {
    "Category": "通用产品",
    "targetPlatform": "WB",
    "ratio": "3:4",
    "Language": "俄文",
    "Country": "俄罗斯"
  },
  "parameterOptions": {
    "Category": ["通用产品", "运动鞋", "手提包", "电吹风", "家居收纳", "锅具", "小家电", "台灯", "上衣"],
    "targetPlatform": ["WB", "OZON", "Yandex", "Shopee", "Amazon"],
    "ratio": ["3:4", "1:1"],
    "Language": ["俄文", "英文", "越南语", "法语", "德语"],
    "Country": ["俄罗斯", "美国", "越南", "法国"]
  }
}
```

## 生成视频（E004）

- 运行时参数文件：`E004_n8n_product_image_task.json`
- 下拉选项文件：`E004_n8n_product_image_task.options.json`

| 字段 | 当前默认值 | 已启用的下拉选项（按界面顺序） |
| --- | --- | --- |
| `effectPreset` | `效果3` | `效果3`、`效果2`、`效果1` |
| `targetDuration` | `15` | `15`、`10`、`20` |

`targetDuration` 的默认值和候选值均为 JSON 数字，不是字符串。

对应的非敏感配置内容：

```json
{
  "parameters": {
    "effectPreset": "效果3",
    "targetDuration": 15
  },
  "parameterOptions": {
    "effectPreset": ["效果3", "效果2", "效果1"],
    "targetDuration": [15, 10, 20]
  }
}
```

## 维护规则

- 字段名大小写必须保持不变，例如 `Category`、`Language` 和 `Country`。
- 下拉选项数组的顺序就是界面显示顺序；修改时不得自动排序或去除业务需要的值。
- 当前默认值必须存在于对应的下拉选项数组中，并保持相同的 JSON 数据类型。
- 本机运行配置发生变更后，应先通过 `GET /api/v1/workflow-parameters/E003` 和 `GET /api/v1/workflow-parameters/E004` 回读，再从本机向 GitHub 更新本文；不得用本文反向覆盖本机运行配置。
