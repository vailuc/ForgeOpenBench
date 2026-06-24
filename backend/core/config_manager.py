import os
import json
import logging
import asyncio
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger("fob.core.config")

class ConfigManager:
    """
    Handles atomic, thread-safe, and async-safe JSON configuration persistence.
    Prevents file corruption by writing to a temporary file before replacing the target.
    """
    def __init__(self, config_dir: Optional[Path] = None):
        # Default to user home configuration directory following XDG standards
        self.config_dir = config_dir or Path(os.path.expanduser("~/.config/ForgeOpenBench"))
        self.config_file = self.config_dir / "settings.json"
        self._lock = asyncio.Lock()
        self._cached_config: Dict[str, Any] = {}

        # Ensure base environment directory exists
        self.config_dir.mkdir(parents=True, exist_ok=True)

    def load_initial_sync(self) -> Dict[str, Any]:
        """Synchronous load meant ONLY for application startup bootstrap."""
        if not self.config_file.exists():
            logger.info(f"No existing configuration found at {self.config_file}. Initializing defaults.")
            self._cached_config = self._get_default_schema()
            self._save_sync(self._cached_config)
            return self._cached_config

        try:
            with open(self.config_file, "r") as f:
                self._cached_config = json.load(f)
                logger.info("Configuration safely loaded into memory cache.")
                return self._cached_config
        except (json.JSONDecodeError, IOError) as e:
            logger.error(f"Configuration file corrupted: {e}. Falling back to clean defaults.")
            self._cached_config = self._get_default_schema()
            return self._cached_config

    async def get_all(self) -> Dict[str, Any]:
        """Thread-safe fetch of the entire configuration space."""
        async with self._lock:
            config = dict(self._cached_config)
            config["version"] = "0.2.1"
            return config

    async def get(self, key: str, default: Any = None) -> Any:
        """Fetch a specific top-level configuration block."""
        async with self._lock:
            return self._cached_config.get(key, default)

    def get_sync(self, key: str, default: Any = None) -> Any:
        """Synchronous fetch from the cached configuration. Safe for sync code paths."""
        return self._cached_config.get(key, default)

    async def set_block(self, key: str, value: Any) -> None:
        """
        Updates a specific configuration section and schedules an atomic write to disk
        without stalling the main asynchronous event execution loop.
        """
        async with self._lock:
            self._cached_config[key] = value
            # Offload heavy/blocking file system I/O to an internal worker thread
            await asyncio.to_thread(self._save_sync, self._cached_config)

    def _save_sync(self, config_data: Dict[str, Any]) -> None:
        """Performs an atomic write operation using standard filesystem flags."""
        temp_file = self.config_file.with_suffix(".tmp")
        try:
            # Write out to a temporary staging file first
            with open(temp_file, "w") as f:
                json.dump(config_data, f, indent=4)
                f.flush()
                os.fsync(f.fileno())  # Force OS buffer flushing directly to storage disk

            # Atomic swap operation — completely transparent to Linux systems
            os.replace(temp_file, self.config_file)
            logger.debug("Configuration successfully synchronized atomically.")
        except IOError as e:
            logger.error(f"Failed to execute atomic write to {self.config_file}: {e}")
            if temp_file.exists():
                try:
                    os.remove(temp_file)
                except Exception:
                    pass
            raise e

    def _get_default_schema(self) -> Dict[str, Any]:
        """The master fallback defaults for the Forge Open Bench runtime workspace."""
        return {
            "version": "0.2.1",
            "workspace": {
                "project_dir": "~/Documents/Forge"
            },
            "system": {
                "theme": "dark",
                "hardware_polling_rate_ms": 10,
                "terminal_font_size": 14
            },
            "transports": {
                "bluetooth": {"enabled": True, "aggressive_polling": True},
                "usb": {"enabled": True, "hotplug_auto_claim": True},
                "wifi": {"enabled": False, "port": 8266}
            },
            "plugins": {
                "noteforge": {"enabled": True},
                "pocketforge": {"enabled": True, "active_profile": "default"},
                "waveforge": {"enabled": True, "coupling": "DC"},
                "lensforge": {"enabled": True},
                "monitorforge": {"enabled": True}
            }
        }
