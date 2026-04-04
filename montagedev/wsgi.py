import os
import subprocess
import sys
from pathlib import Path

# Load .env for local development (no-op on Vercel where env vars are set natively)
env_file = Path(__file__).resolve().parent.parent / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "montagedev.settings")

# Run collectstatic at cold-start (Vercel serverless)
try:
    subprocess.run(
        [sys.executable, "manage.py", "collectstatic", "--noinput"],
        capture_output=True, check=False,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
except Exception:
    pass

from django.core.wsgi import get_wsgi_application
application = get_wsgi_application()

# Auto-create Supabase schema on first cold-start
try:
    from chat.db_init import ensure_db_initialized
    ensure_db_initialized()
except Exception:
    pass

app = application
