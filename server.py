from __future__ import annotations

import json
import os
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "personal-finance-ledger.json"
MAX_REQUEST_BYTES = 1_000_000


def empty_ledger() -> dict:
    return {
        "version": 2,
        "currency": "CNY",
        "settings": {
            "openingBalance": None,
            "payDay": 7,
            "payMonthOffset": 1,
        },
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "records": [],
    }


def ensure_data_file() -> None:
    if DATA_FILE.exists():
        return
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(empty_ledger(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def validate_ledger(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("账本内容必须是 JSON 对象")
    if not isinstance(payload.get("records"), list):
        raise ValueError("账本缺少 records 数组")
    if not isinstance(payload.get("settings"), dict):
        raise ValueError("账本缺少 settings 对象")
    for index, record in enumerate(payload["records"], start=1):
        if not isinstance(record, dict):
            raise ValueError(f"第 {index} 条记录格式错误")
        if not isinstance(record.get("month"), str):
            raise ValueError(f"第 {index} 条记录缺少月份")
    payload["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    return payload


class LedgerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        if self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self) -> None:
        if urlparse(self.path).path != "/api/ledger":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("账本文件大小无效")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            payload = validate_ledger(payload)
            DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary = DATA_FILE.with_name(f".{DATA_FILE.name}.tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, DATA_FILE)
            self._send_json(200, {"ok": True, "path": "data/personal-finance-ledger.json"})
        except (ValueError, json.JSONDecodeError) as error:
            self._send_json(400, {"ok": False, "error": str(error)})
        except OSError:
            self._send_json(500, {"ok": False, "error": "本地数据文件写入失败"})

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ensure_data_file()
    server = ThreadingHTTPServer(("127.0.0.1", 4173), LedgerHandler)
    print("月度账本已启动：http://127.0.0.1:4173/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
