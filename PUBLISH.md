# 发布到 GitHub

目标仓库：

```text
https://github.com/zenghaolinz/chaoxing-learning-super-tool
```

## 使用 GitHub CLI

在项目目录打开 PowerShell：

```powershell
git init
git add .
git commit -m "feat: initial release 1.0.0"
git branch -M main

gh auth login
gh repo create zenghaolinz/chaoxing-learning-super-tool --public --source=. --remote=origin --push
```

## 不使用 GitHub CLI

先在 GitHub 网页创建空仓库：

```text
zenghaolinz/chaoxing-learning-super-tool
```

不要勾选自动创建 README、LICENSE 或 `.gitignore`，然后运行：

```powershell
git init
git add .
git commit -m "feat: initial release 1.0.0"
git branch -M main
git remote add origin https://github.com/zenghaolinz/chaoxing-learning-super-tool.git
git push -u origin main
```

## 验证 Tampermonkey 安装链接

推送完成后打开：

```text
https://raw.githubusercontent.com/zenghaolinz/chaoxing-learning-super-tool/main/chaoxing-learning-super-tool.user.js
```

正常情况下，Tampermonkey 会显示脚本安装页面。

如果只看到纯文本，请检查：

1. Tampermonkey 是否启用；
2. “允许用户脚本”是否开启；
3. 文件名是否以 `.user.js` 结尾；
4. 文件顶部是否保留完整的 `UserScript` 元数据块；
5. 默认分支是否为 `main`。
