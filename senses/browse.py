"""Read-only browse through browser-use 1.0.6 and the local Playwright Chromium.

The model client is ChatOpenAI pointed at the orchestrator's internal proxy.
This process never reads OPENROUTER_API_KEY or BROWSER_USE_API_KEY.

Telemetry is off. browser-use documents the switch as ANONYMIZED_TELEMETRY=false
in https://docs.browser-use.com/open-source/telemetry and in the 1.0 .env.example
(https://github.com/browser-use/browser-use/blob/main/.env.example). Any value that
does not start with t, y, or 1 turns telemetry off. It is set before the library
is imported.

browser-use 1.0 dropped Tools(exclude_actions). Tools() takes no arguments, and
`controller` is only the old name for `tools` (docs: All parameters). Limits are
enforced here: a CDP Fetch interceptor plus a page script, not a prompt.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

# Set before browser-use is imported. Do not read the cloud or OpenRouter keys.
os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ.pop("BROWSER_USE_API_KEY", None)
os.environ.pop("OPENROUTER_API_KEY", None)
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("OPENAI_BASE_URL", None)

MAX_STEPS = 15
BUDGET_S = 180
MAX_DOWNLOAD = 5 * 1024 * 1024
CAPTCHA_RE = ("recaptcha", "hcaptcha", "h-captcha", "cf-turnstile", "funcaptcha", "g-recaptcha")
LOGIN_PARTS = ("/login", "/log-in", "/signin", "/sign-in", "/signup", "/sign-up", "/register")

ROOT = Path(__file__).resolve().parent


def decide_request(record: dict, safety=None, allow_loopback: bool = False) -> dict:
    """Return {block, stop, reason}. block is null when the request may continue."""
    method = str(record.get("method") or "GET").upper()
    url = str(record.get("url") or "")
    resource = str(record.get("resource_type") or record.get("resourceType") or "").lower()
    headers = {str(key).lower(): str(value) for key, value in (record.get("headers") or {}).items()}
    stage = str(record.get("stage") or "request")
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    document = resource in {"document", "navigation"}

    if scheme in {"about", "data", "blob"} and url in {"about:blank", "about:blank/"}:
        return {"block": None, "stop": False, "reason": ""}
    if scheme and scheme not in {"http", "https", "about", "data", "blob"}:
        return {"block": "scheme", "stop": True, "reason": "Only http and https URLs are allowed."}
    if document and scheme not in {"http", "https"}:
        return {"block": "scheme", "stop": True, "reason": "Only http and https URLs are allowed."}

    lowered = url.lower()
    if any(marker in lowered for marker in CAPTCHA_RE):
        return {"block": "captcha", "stop": True, "reason": "blocked: captcha"}

    path = (parsed.path or "/").lower()
    if any(path == part or path.startswith(part + "/") for part in LOGIN_PARTS):
        return {"block": "login", "stop": True, "reason": "Login and sign-up flows are blocked."}

    if method not in {"GET", "HEAD", "OPTIONS"}:
        return {"block": "form", "stop": document or method in {"POST", "PUT", "PATCH", "DELETE"}, "reason": "Form submission is blocked."}

    if stage == "response":
        length = _length(headers.get("content-length"))
        if _is_download(headers) and (length is None or length > MAX_DOWNLOAD):
            return {"block": "download", "stop": True, "reason": "Downloads over 5 MB are blocked."}

    if scheme in {"http", "https"} and safety is not None:
        if allow_loopback and parsed.hostname in {"127.0.0.1", "localhost"}:
            return {"block": None, "stop": False, "reason": ""}
        allowed, reason = safety(url)
        if not allowed:
            return {"block": "safety", "stop": document, "reason": reason or "URL is blocked."}
    return {"block": None, "stop": False, "reason": ""}


def _length(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _is_download(headers: dict) -> bool:
    disposition = headers.get("content-disposition", "")
    content_type = headers.get("content-type", "")
    if "attachment" in disposition.lower():
        return True
    return any(token in content_type.lower() for token in ("application/octet-stream", "application/zip", "application/gzip", "application/pdf"))


def guard_report() -> dict:
    post = decide_request({"method": "POST", "url": "https://example.com/send", "resource_type": "document", "stage": "request"})
    download = decide_request(
        {
            "method": "GET",
            "url": "https://example.com/file.bin",
            "resource_type": "document",
            "stage": "response",
            "headers": {"content-length": str(MAX_DOWNLOAD + 1), "content-disposition": "attachment; filename=big.bin"},
        }
    )
    small = decide_request(
        {
            "method": "GET",
            "url": "https://example.com/file.bin",
            "resource_type": "document",
            "stage": "response",
            "headers": {"content-length": "100", "content-disposition": "attachment; filename=small.bin"},
        }
    )
    scheme = decide_request({"method": "GET", "url": "file:///etc/passwd", "resource_type": "document", "stage": "request"})
    captcha = decide_request({"method": "GET", "url": "https://example.com/recaptcha/api.js", "resource_type": "script", "stage": "request"})
    login = decide_request({"method": "GET", "url": "https://example.com/login", "resource_type": "document", "stage": "request"})
    allowed = decide_request({"method": "GET", "url": "https://example.com/notes", "resource_type": "document", "stage": "request"})
    return {
        "post": post,
        "download": download,
        "small_download": small,
        "scheme": scheme,
        "captcha": captcha,
        "login": login,
        "get": allowed,
        "max_steps": MAX_STEPS,
        "budget_s": BUDGET_S,
        "telemetry": os.environ.get("ANONYMIZED_TELEMETRY"),
    }


class _Decider(BaseHTTPRequestHandler):
    safety = None
    allow_loopback = False

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            record = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            record = {}
        decision = decide_request(record, self.safety, self.allow_loopback)
        body = json.dumps(decision).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        return


class SafetyClient:
    def __init__(self, deny_hosts: list[str]) -> None:
        script = ROOT / "src" / "safety-check.ts"
        env = os.environ.copy()
        env["DENY_HOSTS"] = json.dumps(deny_hosts)
        env["ANONYMIZED_TELEMETRY"] = "false"
        env.pop("BROWSER_USE_API_KEY", None)
        env.pop("OPENROUTER_API_KEY", None)
        self.proc = subprocess.Popen(
            ["node", str(script)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env=env,
        )
        self.lock = threading.Lock()

    def check(self, url: str) -> tuple[bool, str]:
        with self.lock:
            if not self.proc.stdin or not self.proc.stdout:
                return False, "URL check is unavailable."
            self.proc.stdin.write(json.dumps({"url": url}) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        try:
            verdict = json.loads(line)
        except json.JSONDecodeError:
            return False, "URL check failed."
        return bool(verdict.get("allowed")), str(verdict.get("reason") or "")

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.terminate()


def _start_decider(safety, allow_loopback: bool) -> tuple[ThreadingHTTPServer, str]:
    _Decider.safety = safety
    _Decider.allow_loopback = allow_loopback
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Decider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    return server, f"http://127.0.0.1:{port}/decide"


def _run_fixture(fixture: str) -> dict:
    server, decider = _start_decider(safety=None, allow_loopback=True)
    guard = ROOT / "src" / "guard-browser.ts"
    env = os.environ.copy()
    env.update(
        {
            "BROWSE_DECIDER": decider,
            "BROWSE_EXERCISE": "1",
            "FIXTURE_URL": fixture,
            "ANONYMIZED_TELEMETRY": "false",
        }
    )
    env.pop("BROWSER_USE_API_KEY", None)
    env.pop("OPENROUTER_API_KEY", None)
    proc = subprocess.Popen(
        ["node", str(guard)],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    exercise = {"skipped": True, "reason": "guard produced no result"}
    assert proc.stdout is not None
    for line in proc.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == "skipped":
            exercise = {"skipped": True, "reason": event.get("reason", "browser unavailable")}
            break
        if event.get("event") == "exercise":
            exercise = {"skipped": False, "form": event.get("form"), "download": event.get("download"), "events": True}
            break
        if event.get("event") == "stop" and event.get("block") == "form":
            exercise["form"] = "blocked"
        if event.get("event") == "stop" and event.get("block") == "download":
            exercise["download"] = "blocked"
    proc.wait(timeout=30)
    server.shutdown()
    stderr = ""
    if proc.stderr:
        stderr = proc.stderr.read()[:500]
    if exercise.get("skipped") and stderr and "Cannot find module 'playwright'" in stderr:
        exercise["reason"] = "playwright is not installed"
    return exercise


def _cap_steps(value) -> int:
    try:
        steps = int(value)
    except (TypeError, ValueError):
        return MAX_STEPS
    if steps < 1:
        return 1
    return min(steps, MAX_STEPS)


def _run_agent(payload: dict) -> dict:
    task = str(payload.get("task") or "").strip()
    if not task:
        return {"ok": False, "error": "task is required.", "outcome": "error", "steps": 0, "urls": [], "transcript": []}
    steps = _cap_steps(payload.get("max_steps", MAX_STEPS))
    budget = min(BUDGET_S, int(payload.get("budget_s") or BUDGET_S))
    deny_hosts = payload.get("deny_hosts") or []
    if not isinstance(deny_hosts, list):
        deny_hosts = []
    safety = SafetyClient([str(item) for item in deny_hosts])
    server, decider = _start_decider(safety.check, allow_loopback=False)
    guard_script = ROOT / "src" / "guard-browser.ts"
    env = os.environ.copy()
    env["BROWSE_DECIDER"] = decider
    env["ANONYMIZED_TELEMETRY"] = "false"
    env.pop("BROWSER_USE_API_KEY", None)
    env.pop("OPENROUTER_API_KEY", None)
    guard = subprocess.Popen(
        ["node", str(guard_script)],
        cwd=str(ROOT),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    urls: list[str] = []
    outcome = {"value": "ok"}
    cdp = {"url": ""}

    def read_guard() -> None:
        assert guard.stdout is not None
        for line in guard.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("event") == "ready":
                cdp["url"] = str(event.get("cdp") or "")
            elif event.get("event") == "url" and event.get("url"):
                url = str(event["url"])
                if url not in urls:
                    urls.append(url)
            elif event.get("event") == "stop":
                block = str(event.get("block") or "blocked")
                outcome["value"] = "blocked: captcha" if block == "captcha" else f"blocked: {block}"

    reader = threading.Thread(target=read_guard, daemon=True)
    reader.start()
    try:
        import asyncio

        from browser_use import Agent, Browser, ChatOpenAI

        async def go() -> dict:
            for _ in range(100):
                if cdp["url"] or outcome["value"] != "ok":
                    break
                await asyncio.sleep(0.05)
            if not cdp["url"]:
                return {"ok": False, "error": "Local browser did not start.", "outcome": "error", "steps": 0, "urls": urls, "transcript": []}
            if outcome["value"].startswith("blocked"):
                return _done("", 0, urls, [], outcome["value"])
            llm = ChatOpenAI(
                model=str(payload.get("model") or "openrouter/auto"),
                api_key=str(payload.get("llm_token") or "browse"),
                base_url=str(payload.get("llm_base_url") or ""),
            )
            agent = Agent(
                task,
                llm=llm,
                browser=Browser(cdp_url=cdp["url"]),
                judge=False,
                web_search=False,
                highlight_actions=False,
                extend_system_message=(
                    "Read only. Do not submit forms, log in, sign up, type passwords, "
                    "upload files, download large files, or solve CAPTCHAs."
                ),
            )
            result = await asyncio.wait_for(agent.run(max_steps=steps, timeout=budget), timeout=budget)
            final = ""
            final_fn = getattr(result, "final_result", None)
            if callable(final_fn):
                try:
                    final = final_fn() or ""
                except Exception as exc:  # noqa: BLE001
                    final = str(exc)
            history = getattr(result, "history", None)
            taken = len(history) if isinstance(history, list) else steps
            transcript = {"final": final, "repr": repr(result)[:4000]}
            status = outcome["value"]
            if status == "ok" and not final:
                final = "Browse finished without a text result."
            if status.startswith("blocked"):
                final = status
            return _done(str(final), min(taken, steps), urls, transcript, status)

        return asyncio.run(go())
    except ImportError:
        return {
            "ok": False,
            "error": "browser-use is not installed",
            "outcome": "error",
            "steps": 0,
            "urls": [],
            "transcript": [],
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:300], "outcome": "error", "steps": 0, "urls": urls, "transcript": []}
    finally:
        if guard.stdin:
            guard.stdin.close()
        guard.terminate()
        safety.close()
        server.shutdown()


def _done(result: str, steps: int, urls: list[str], transcript, outcome: str) -> dict:
    return {
        "ok": True,
        "result": result,
        "steps": steps,
        "urls": urls,
        "transcript": transcript,
        "outcome": outcome,
    }


def main() -> int:
    if "--guards" in sys.argv:
        json.dump(guard_report(), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if "--fixture" in sys.argv:
        index = sys.argv.index("--fixture")
        fixture = sys.argv[index + 1] if index + 1 < len(sys.argv) else ""
        json.dump(_run_fixture(fixture), sys.stdout)
        sys.stdout.write("\n")
        return 0
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    json.dump(_run_agent(payload), sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
