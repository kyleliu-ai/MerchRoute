#!/usr/bin/env python3
"""
即梦 AI (jimeng.jianying.com) 历史 Session 强制退出工具
==========================================================

功能：
  通过 Playwright headless 浏览器模拟登录，点击"设置 → 退出"按钮，
  批量使指定的历史 sessionid 在服务器端失效。

适用场景：
  当 sessionid 泄露或安全审计时，强制注销不再使用的历史 cookie，
  防止被未授权方继续调用 API。

使用方法：
  python3 scripts/logout-sessions.py <sessionid1> [sessionid2] ...

  或在脚本末尾的 SESSION_IDS 列表中填写需要退出的 sessionid，
  然后直接运行：
  python3 scripts/logout-sessions.py

依赖安装：
  pip install playwright
  playwright install chromium

注意：
  - 每个 sessionid 独立启动浏览器实例执行退出，互不影响
  - 已失效的 sessionid 会自动跳过
  - 退出操作不可逆，请确认 sessionid 列表无误后再执行
"""

import sys
import time
import argparse

# -------------------------------------------------------
# 在此填写需要强制退出的历史 sessionid 列表
# 也可通过命令行参数传入（见使用方法）
# -------------------------------------------------------
SESSION_IDS = [
    # 示例（已失效，仅作格式参考）：
    # "aabbddddddddddddddd",
]


def logout_session(session_id: str) -> str:
    """
    对单个 sessionid 执行退出操作。

    返回值：
      "success"        - 退出成功
      "already_invalid"- sessionid 已失效，无需处理
      "error_no_button"- 找不到退出按钮
      "unknown"        - 退出状态不确定
      "error"          - 发生异常
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
        )

        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/135.0.0.0 Safari/537.36"
            ),
        )

        domain = ".jianying.com"
        context.add_cookies(
            [
                {"name": "_tea_web_id", "value": "7619975442964235802", "domain": domain, "path": "/"},
                {"name": "is_staff_user",   "value": "false",      "domain": domain, "path": "/"},
                {"name": "store-region",    "value": "cn-gd",      "domain": domain, "path": "/"},
                {"name": "uid_tt",          "value": session_id,   "domain": domain, "path": "/"},
                {"name": "uid_tt_ss",       "value": session_id,   "domain": domain, "path": "/"},
                {"name": "sid_tt",          "value": session_id,   "domain": domain, "path": "/"},
                {"name": "sessionid",       "value": session_id,   "domain": domain, "path": "/"},
                {"name": "sessionid_ss",    "value": session_id,   "domain": domain, "path": "/"},
            ]
        )

        page = context.new_page()

        try:
            # 导航到即梦主页，等待页面完全加载
            page.goto(
                "https://jimeng.jianying.com",
                timeout=30000,
                wait_until="networkidle",
            )
            time.sleep(3)

            # 检查是否已登录（通过全局变量 window.__isLogined）
            is_logged_in = page.evaluate("() => window.__isLogined === true")
            if not is_logged_in:
                return "already_invalid"

            # 步骤 1：点击左侧底部设置按钮（#SiderMenuSetting）
            # 该按钮点击后会弹出下拉菜单，菜单中包含"退出"选项
            setting_el = page.wait_for_selector("#SiderMenuSetting", timeout=8000)
            setting_el.click()
            time.sleep(2)

            # 步骤 2：查找弹出菜单中的"退出"按钮并点击
            # 优先使用文字 selector，备选使用 class 包含文字方式
            exit_btn = page.query_selector("text=退出")
            if not exit_btn:
                exit_btn = page.query_selector('.lv-dropdown-menu-item:has-text("退出")')

            if not exit_btn:
                return "error_no_button"

            # 监听退出请求（可用于日志记录）
            logout_requests: list[str] = []

            def on_request(req):
                if any(k in req.url for k in ["logout", "sign_out", "revoke", "signout"]):
                    logout_requests.append(req.url)

            page.on("request", on_request)

            # 执行点击
            exit_btn.click()
            time.sleep(4)

            # 验证退出结果
            after_state = page.evaluate("() => window.__isLogined")
            current_url = page.url

            if after_state is False or "login" in current_url:
                return "success"

            # 再次确认：检查页面是否有登录入口文字
            page_content = page.content()
            if "登录" in page_content[:1000]:
                return "success"

            return "unknown"

        except Exception as e:
            print(f"    [异常] {e}")
            return "error"
        finally:
            browser.close()


def main():
    parser = argparse.ArgumentParser(
        description="即梦 AI 历史 Session 强制退出工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "sessions",
        nargs="*",
        help="需要退出的 sessionid（可传多个，空格分隔）",
    )
    args = parser.parse_args()

    # 命令行参数优先，否则使用脚本顶部的 SESSION_IDS 列表
    targets = args.sessions if args.sessions else SESSION_IDS

    if not targets:
        parser.print_help()
        print(
            "\n❌ 错误：未指定任何 sessionid。\n"
            "   请通过命令行传入或在脚本顶部的 SESSION_IDS 列表中填写。"
        )
        sys.exit(1)

    # 去重并过滤空值
    targets = [s.strip() for s in targets if s.strip()]
    targets = list(dict.fromkeys(targets))  # 保序去重

    print(f"\n即梦 AI 历史 Session 强制退出工具")
    print(f"{'=' * 60}")
    print(f"共 {len(targets)} 个 sessionid 待处理\n")

    STATUS_ICONS = {
        "success":        "✅  退出成功（服务器端已失效）",
        "already_invalid":"⬜  已失效，无需处理",
        "error_no_button":"❌  找不到退出按钮（页面结构可能已变更）",
        "unknown":        "⚠️   退出状态不确定，请手动验证",
        "error":          "❌  发生异常，请查看上方错误信息",
    }

    results: dict[str, str] = {}

    for idx, sid in enumerate(targets, 1):
        print(f"[{idx}/{len(targets)}] 处理: {sid}")
        result = logout_session(sid)
        results[sid] = result
        icon = STATUS_ICONS.get(result, result)
        print(f"         → {icon}\n")
        time.sleep(1)  # 各次请求间隔，避免触发频率限制

    # 汇总报告
    print(f"\n{'=' * 60}")
    print("退出结果汇总：")
    print(f"{'=' * 60}")
    for sid, result in results.items():
        icon = STATUS_ICONS.get(result, result)
        print(f"  {sid}  →  {icon}")

    success_count = sum(1 for r in results.values() if r == "success")
    invalid_count = sum(1 for r in results.values() if r == "already_invalid")
    fail_count = len(results) - success_count - invalid_count

    print(f"\n  ✅ 成功退出：{success_count} 个")
    print(f"  ⬜ 已失效：  {invalid_count} 个（无需处理）")
    if fail_count > 0:
        print(f"  ❌ 处理失败：{fail_count} 个（请手动处理）")
    print()


if __name__ == "__main__":
    main()
