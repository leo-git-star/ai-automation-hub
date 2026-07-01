@echo off
chcp 65001 >nul
echo ================================================
echo      AI Automation Hub - 推送代码到GitHub
echo ================================================
echo.
echo 请确保已安装Git并配置好GitHub账号
echo.

set "repo=https://github.com/leo-git-star/ai-automation-hub.git"

echo 正在初始化Git仓库...
git init
git config user.email "automation@ai-hub.com"
git config user.name "AI Automation Hub"

echo.
echo 正在添加文件...
git add .

echo.
echo 正在提交...
git commit -m "AI Automation Hub - Enterprise Workflow Automation Platform"

echo.
echo 正在添加远程仓库...
git remote add origin %repo%

echo.
echo 正在推送代码...
git push -u origin master

if %errorlevel% equ 0 (
    echo.
    echo ================================================
    echo              推送成功！
    echo ================================================
    echo.
    echo 仓库地址: %repo%
    echo.
    echo 现在可以去 Vercel 或 Render 部署了！
    echo.
) else (
    echo.
    echo ================================================
    echo              推送失败
    echo ================================================
    echo.
    echo 请尝试以下方法：
    echo 1. 打开 Git Bash 运行: git push -u origin master
    echo 2. 手动输入GitHub用户名和密码
    echo 3. 配置SSH密钥: https://docs.github.com/en/authentication/connecting-to-github-with-ssh
    echo.
)

pause