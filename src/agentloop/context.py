from __future__ import annotations

from collections.abc import Sequence
from typing import cast

import tiktoken
from pydantic_ai.messages import ModelMessage


def _encode_length(text: str, model: str) -> int:
    try:
        encoder = tiktoken.get_encoding(model)
        return len(encoder.encode(text))
    except Exception:
        return max(1, len(text) // 4)


def _message_text(message: ModelMessage) -> str:
    serializer = getattr(message, "model_dump_json", None)
    if callable(serializer):
        return cast(str, serializer())
    return repr(message)


def trim_messages(
    history: Sequence[ModelMessage],
    max_tokens: int,
    model: str = "cl100k_base",
) -> list[ModelMessage]:
    total = 0
    kept: list[ModelMessage] = []
    for message in reversed(history):
        cost = _encode_length(_message_text(message), model)
        if kept and total + cost > max_tokens:
            break
        kept.append(message)
        total += cost
    return list(reversed(kept))
