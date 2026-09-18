import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from huddol.adapters.execution.worker import main

raise SystemExit(main())
