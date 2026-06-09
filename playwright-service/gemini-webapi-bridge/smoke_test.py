import asyncio
import os
from pathlib import Path

from gemini_webapi import GeminiClient, set_log_level
from gemini_webapi.constants import AccountStatus


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


async def main() -> None:
    base_dir = Path(__file__).resolve().parents[1]
    load_env(base_dir / ".env")
    set_log_level("WARNING")

    secure_1psid = os.environ.get("GEMINI_SECURE_1PSID", "").strip()
    secure_1psidts = os.environ.get("GEMINI_SECURE_1PSIDTS", "").strip()
    if not secure_1psid:
        raise RuntimeError("GEMINI_SECURE_1PSID is missing")

    client = GeminiClient(secure_1psid, secure_1psidts, proxy=os.environ.get("GEMINI_WEBAPI_PROXY") or None)
    await client.init(timeout=60, auto_close=True, close_delay=30, auto_refresh=True)
    if client.account_status != AccountStatus.AVAILABLE:
        raise RuntimeError(f"Gemini account status is {client.account_status.name}: {client.account_status.description}")
    print("gemini client init ok")
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
