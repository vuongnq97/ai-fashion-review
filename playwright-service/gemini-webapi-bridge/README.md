# Gemini WebAPI Bridge

This bridge replaces the AI Studio UI automation step for storyboard generation.

Install:

```sh
python -m pip install -r playwright-service/gemini-webapi-bridge/requirements.txt
```

Required environment variables:

```env
GEMINI_SECURE_1PSID=...
GEMINI_SECURE_1PSIDTS=...
GEMINI_COOKIE_PATH=./gemini-cookies
```

The Node service invokes `gemini_storyboard.py` with temporary JSON request and
response files. Keep cookies out of git.
