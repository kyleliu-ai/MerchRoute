# 故障排查

## 页面进入系统设置

至少一个审核阶段的候选目录不存在或不可读。打开阶段标签，核对绝对路径并点击“验证”。候选目录不会自动创建。

## 图片不显示

检查文件扩展名是否属于 `.jpg/.jpeg/.png/.webp/.avif/.bmp`。GIF、SVG、TIFF、PSD 和 RAW 在 v001 中会被忽略。符号链接也会被跳过。

## `SOURCE_FILE_MISSING`

保存草稿或审批后，源文件被外部程序移动或删除。返回审核页移除失效项，再重新审批。

## `TARGET_FOLDER_EXISTS`

目标正式目录已存在。默认策略不会覆盖；在待投递清单选择“创建修订版本”，系统会生成 `__R02`、`__R03`。

## `PARTIAL_SUCCESS`

监听目录已经成功入队，但审核归档失败。不要手动删除监听目录，修复归档目录后点击“重试失败项”，应用只补失败的归档环节。

## `.staging` 残留

系统设置会列出暂存目录。只有超过 24 小时的目录可以安全清理，24 小时以内不会自动删除。

## 端口占用

修改 `.env`：

```dotenv
PORT=4174
```

## 查看日志

日志位于应用数据目录的 `logs/app-YYYY-MM-DD.log`，采用逐行 JSON。日志不会记录图片二进制内容。

## 重新验证

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```
