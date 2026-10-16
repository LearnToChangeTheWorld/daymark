"""Local Windows Weixin UI adapter; only login controls and selected chats are read.

UI element reference: Hello-Mr-Crab/pywechat (WeChatTools and Uielements).
No message sending, account logout, registry accessibility changes or hooks.
"""
import sys, json, os, time, base64, io, subprocess
from datetime import datetime, timezone
from pywinauto import Desktop

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')
desktop = Desktop(backend='uia')

def windows():
    # Filter by the official client's process ID before inspecting any UI content.
    import win32gui, win32process
    handles = []
    def callback(hwnd, _):
        if win32gui.GetClassName(hwnd) not in ('Qt51514QWindowIcon', 'WeChatMainWndForPC', 'WeChatLoginWndForPC'):
            return
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        try:
            import win32api, win32con
            proc = win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION | win32con.PROCESS_VM_READ, False, pid)
            exe = win32process.GetModuleFileNameEx(proc, 0)
            proc.Close()
            if os.path.basename(exe).lower() in ('weixin.exe', 'wechat.exe'):
                handles.append(hwnd)
        except Exception:
            pass
    win32gui.EnumWindows(callback, None)
    return [desktop.window(handle=hwnd) for hwnd in handles]

def main_and_login():
    main, login = None, None
    for window in windows():
        try:
            cls = window.element_info.class_name
            if cls in ('mmui::LoginWindow', 'WeChatLoginWndForPC'):
                login = window
            if cls in ('mmui::MainWindow', 'WeChatMainWndForPC'):
                main = window
        except Exception:
            pass
    return main, login

def status():
    main, login = main_and_login()
    if main:
        buttons = main.descendants(control_type='Button', depth=5)
        offline = any(x.window_text() in ('当前网络不可用', '网络连接已断开') for x in buttons)
        return {'loginState': 'offline' if offline else 'authenticated', 'account': main.window_text(),
                'readable': len(buttons) >= 3, 'message': '微信账号已登录' if len(buttons) >= 3 else '微信已登录，但客户端未开放消息读取权限；无法确认群消息采集可用'}
    if login:
        return {'loginState': 'waiting_scan', 'readable': False, 'message': '请使用手机微信扫描登录窗口二维码，并在手机上确认'}
    for window in windows():
        try:
            if window.is_visible() and window.element_info.class_name == 'Qt51514QWindowIcon':
                return {'loginState': 'unreadable', 'readable': False, 'message': '已检测到微信窗口，但客户端未向系统开放内部消息控件，无法自动确认登录和读取群消息。若你已经登录，请勿重复扫码；当前界面读取方式不可用。'}
        except Exception:
            pass
    return {'loginState': 'not_running', 'readable': False, 'message': '微信客户端尚未启动，或窗口不可访问'}

def start(payload):
    current = status()
    if current['loginState'] == 'unreadable':
        return current
    main, login = main_and_login()
    if main:
        return status()
    if not login:
        candidates = [os.environ.get('STUDENT_INBOX_WECHAT_PATH', ''), r'C:\Program Files\Tencent\Weixin\Weixin.exe',
                      r'C:\Program Files (x86)\Tencent\WeChat\WeChat.exe']
        path = next((p for p in candidates if p and os.path.isfile(p)), None)
        if not path:
            return {'loginState': 'client_missing', 'readable': False, 'message': '未找到官方微信客户端，请先安装 Windows 微信'}
        subprocess.Popen([path])
        for _ in range(30):
            time.sleep(.3)
            main, login = main_and_login()
            if main or login:
                break
    if login:
        login.restore()
        # Switch only on the login page, never log out an already logged-in account.
        for label in ('切换账号', 'Switch Account', '切換賬號', '扫码登录'):
            candidate = login.child_window(title=label)
            if candidate.exists(timeout=.1):
                candidate.wrapper_object().click_input()
                time.sleep(.5)
                break
        result = status()
        # This is a real official login-window capture, not a fabricated QR code.
        output = io.BytesIO()
        login.capture_as_image().save(output, format='PNG')
        result['qrImage'] = base64.b64encode(output.getvalue()).decode('ascii')
        result['qrExpiresAt'] = datetime.fromtimestamp(time.time() + 240, timezone.utc).isoformat()
        return result
    return status()

def groups():
    main, _ = main_and_login()
    if not main:
        return {'groups': [], **status()}
    values = []
    for item in main.descendants(control_type='ListItem', depth=8):
        auto_id = item.element_info.automation_id or ''
        if auto_id.startswith('session_item_'):
            name = auto_id[len('session_item_'):]
            if name and name not in values:
                values.append(name)
    return {'groups': [{'id': n, 'name': n} for n in values], 'message': '当前会话列表；请选择需要收集的群聊，不要选择私人会话。也可填写完整群名称。'}

def read_groups(payload):
    state = status()
    if state['loginState'] != 'authenticated' or not state['readable']:
        return {**state, 'chats': [], 'errors': [state['message']]}
    selected = payload.get('groups', [])
    chats, errors = [], []
    main, _ = main_and_login()
    for group in selected:
        # Only inspect already-open selected group windows. Opening via search is
        # deliberately explicit in the UI to avoid touching an unrelated chat.
        candidates = [main] + windows()
        found = False
        for window in candidates:
            try:
                inputs = window.descendants(control_type='Edit', depth=8)
                chat_input = next((x for x in inputs if x.element_info.automation_id == 'chat_input_field' and x.window_text() == group), None)
                title_match = window.window_text() == group
                if not title_match and chat_input is None:
                    # Chat title is a dedicated title Text, not text in message bodies.
                    titles = window.descendants(control_type='Text', depth=5)
                    title_match = any(x.window_text() == group and 'title' in (x.element_info.automation_id or '').lower() for x in titles)
                if not title_match and chat_input is None:
                    continue
                found = True
                lists = window.descendants(control_type='List', depth=9)
                messages = next((x for x in lists if x.window_text() in ('消息', 'Messages', '訊息')), None)
                if messages is None:
                    errors.append(group + '：未能读取消息列表，请保持该群独立聊天窗口打开')
                    break
                items = []
                for message in messages.children(control_type='ListItem'):
                    text = message.window_text().strip()
                    if text:
                        items.append({'text': text[:12000], 'runtimeId': list(message.element_info.runtime_id or [])})
                chats.append({'id': group, 'messages': items})
                break
            except Exception:
                continue
        if not found:
            errors.append(group + '：请在微信中双击该群，打开独立聊天窗口并保持打开')
    return {**state, 'chats': chats, 'errors': errors}

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir')
    args = parser.parse_args()
    reader = None
    if args.data_dir:
        from wechat_database import DatabaseReader
        reader = DatabaseReader(args.data_dir)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            action = request.get('action')
            if reader and action in ('start', 'refresh', 'status'):
                result = reader.status()
                if action != 'status' and result['loginState'] in ('not_running', 'waiting_scan'):
                    ui = start(request)
                    result = reader.status()
                    if ui.get('qrImage'):
                        result['qrImage'] = ui['qrImage']
                    elif result['loginState'] == 'waiting_scan':
                        from wechat_login import login_image
                        image = login_image()
                        if image:
                            result['qrImage'] = base64.b64encode(image).decode('ascii')
            elif reader and action == 'initialize':
                result = reader.initialize()
            elif reader and action == 'groups':
                result = reader.groups()
            elif reader and action == 'read':
                result = reader.read(request)
            elif action == 'close':
                if reader and reader.setup_child and reader.setup_child.poll() is None:
                    reader.setup_child.terminate()
                result = {'closed': True}
            elif action in ('start', 'refresh'):
                result = start(request)
            elif action == 'status':
                result = status()
            elif action == 'groups':
                result = groups()
            elif action == 'read':
                result = read_groups(request)
            else:
                result = {'error': '不支持的操作'}
            print(json.dumps({'id': request.get('id'), 'result': result}, ensure_ascii=False), flush=True)
        except Exception:
            # Exception strings may contain private UI text; keep them out of logs.
            print(json.dumps({'id': request.get('id') if isinstance(request, dict) else None,
                              'result': {'error': '无法读取本机微信，请检查客户端状态或点击重新初始化；原消息与采集位置已保留'}}), flush=True)


if __name__ == '__main__':
    main()
