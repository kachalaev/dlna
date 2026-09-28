import logging
import sys

import uvicorn

from app.config import load_config
from app.main import create_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config_path = sys.argv[1] if len(sys.argv) > 1 else "config.yaml"
    try:
        config = load_config(config_path)
    except (FileNotFoundError, ValueError, OSError) as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
    uvicorn.run(create_app(config), host=config.host, port=config.port)


if __name__ == "__main__":
    main()
