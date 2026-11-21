"""Numeric usage only; never log prompts, credentials or tool data."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from litellm.integrations.custom_logger import CustomLogger


class UsageMeter(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        response = kwargs.get("complete_streaming_response") or response_obj
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        usage = usage.model_dump() if hasattr(usage, "model_dump") else dict(usage)
        def numeric(value):
            if isinstance(value, dict):
                return {k: numeric(v) for k, v in value.items() if isinstance(v, (int, float, dict))}
            return value
        target = Path(os.environ["CODE_AI_GEMINI_RUNTIME"]) / "usage.jsonl"
        row = {"model": kwargs.get("model"), "at": datetime.now(timezone.utc).isoformat(),
               "usage": numeric(usage), "catalogEstimatedUsd": kwargs.get("response_cost")}
        fd = os.open(target, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a") as handle:
            handle.write(json.dumps(row) + "\n")


meter = UsageMeter()
