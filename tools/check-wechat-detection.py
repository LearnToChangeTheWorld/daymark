"""Regression for Weixin's opaque Qt window; never opens or interacts with it."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('wechat_bridge', Path(__file__).resolve().parents[1] / 'collector' / 'wechat_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

opaque = SimpleNamespace(element_info=SimpleNamespace(class_name='Qt51514QWindowIcon'), is_visible=lambda: True)
with patch.object(bridge, 'windows', return_value=[opaque]), patch.object(bridge.subprocess, 'Popen') as launch:
    assert bridge.status()['loginState'] == 'unreadable'
    assert bridge.start({})['loginState'] == 'unreadable'
    launch.assert_not_called()
with patch.object(bridge, 'windows', return_value=[]):
    assert bridge.status()['loginState'] == 'not_running'
print('Opaque Qt WeChat is detected as unreadable and never relaunched; absent client remains not_running.')
