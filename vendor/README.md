# Local chat components

QQ uses the unmodified Windows Shell release of [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ), v4.18.38. Copyright © 2024 Mlikiowa. Its full upstream license is in `NapCat.LICENSE`; it is a custom limited redistribution, non-commercial license. The runtime is downloaded separately and excluded from source control. Do not describe it as MIT/Apache software or bundle modified upstream code for public redistribution.

Asset: https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.38/NapCat.Shell.zip

SHA-256: `735f2e633247df3ffd6e8ee8b84d7039c315b2655f5807e5f0029f93d2c30016`

`tools/setup-chat.ps1` verifies this pinned digest before extraction. The connector starts a dedicated process with this runtime; it does not modify installed QQ files. Platform sessions are managed by QQ, and this application's local component API and OneBot socket bind only to loopback.

The WeChat database adapter is implemented in `collector/wechat_database.py`; its one-time Windows key initialization and committed WAL reader reuse MIT code pinned in `collector/wechat_vendor/README.md`, with the full license alongside. Python dependencies include pycryptodome 3.23.0, frida 17.8.0 and zstandard 0.25.0, downloaded from PyPI and verified against its published SHA-256 digests. The retained legacy UI adapter uses pywinauto, pywin32 and Pillow. UI selector/compatibility research references [Hello-Mr-Crab/pywechat](https://github.com/Hello-Mr-Crab/pywechat), specifically its Weixin 4.0 documentation and UI element names. This application does not import or redistribute the pywechat package. Installed Python wheels retain their own license files.

Both routes are read-only message collectors. The adapter calls no send-message action. Native client sessions and local diagnostics can contain private account data; do not publish runtime caches or the `data/` directory.
