"""Private numeric provider telemetry. Never persist prompts, tools or credentials."""
import json
import os
from pathlib import Path

from litellm.integrations.custom_logger import CustomLogger


class UsageMeter(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        response = kwargs.get("complete_streaming_response") or response_obj
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump(exclude_none=True)
        record = {
            "model": kwargs.get("model"),
            "finished_at": end_time.astimezone().isoformat(),
            "duration_seconds": (end_time - start_time).total_seconds(),
            "usage": usage,
            "cost_usd": kwargs.get("response_cost"),
        }
        target = Path(os.environ["CODE_AI_GEMINI_RUNTIME"]) / "evidence" / "usage.jsonl"
        fd = os.open(target, os.O_APPEND | os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as stream:
            stream.write(json.dumps(record, default=str) + "\n")


meter = UsageMeter()
