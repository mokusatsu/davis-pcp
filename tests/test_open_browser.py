"""Test open_browser watcher behavior."""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fullstack.backend.app.open_browser import wait_and_open_browser


def test_open_browser_detection(tmp_path, monkeypatch):
    ready_file = tmp_path / ".server_ready"
    ready_file.write_text("ready\n")

    monkeypatch.setenv("DAVIS_PCP_READY_FILE", str(ready_file))
    monkeypatch.setenv("DAVIS_PCP_URL", "http://127.0.0.1:8420/")

    mock_resp = MagicMock()
    mock_resp.status = 200

    with patch("urllib.request.urlopen") as mock_urlopen, patch("webbrowser.open") as mock_browser:
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        success = wait_and_open_browser(timeout_seconds=2.0, poll_interval=0.05)
        assert success is True
        mock_browser.assert_called_once_with("http://127.0.0.1:8420/")


def test_open_browser_timeout_when_not_ready(tmp_path, monkeypatch):
    non_existent = tmp_path / ".not_ready"
    monkeypatch.setenv("DAVIS_PCP_READY_FILE", str(non_existent))

    with patch("webbrowser.open") as mock_browser:
        success = wait_and_open_browser(timeout_seconds=0.2, poll_interval=0.05)
        assert success is False
        mock_browser.assert_not_called()
