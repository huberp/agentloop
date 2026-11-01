from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.mistral import MistralModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.mistral import MistralProvider
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider

from agentloop.config import Settings, settings as default_settings
from agentloop.errors import LLMAPIError


ProviderModel = Model


def create_model(config: Settings | None = None) -> ProviderModel:
    resolved = config or default_settings
    return create_model_for_provider(
        provider=resolved.llm_provider,
        model_name=resolved.llm_model,
        api_key=resolved.mistral_api_key.get_secret_value(),
    )


def create_model_for_provider(
    provider: str,
    model_name: str,
    api_key: str | None = None,
    *,
    provider_kwargs: Mapping[str, Any] | None = None,
) -> ProviderModel:
    kwargs = dict(provider_kwargs or {})
    if provider == "mistral":
        return MistralModel(model_name, provider=MistralProvider(api_key=api_key, **kwargs))
    if provider == "openai":
        return OpenAIChatModel(model_name, provider=OpenAIProvider(api_key=api_key, **kwargs))
    if provider == "anthropic":
        return AnthropicModel(model_name, provider=AnthropicProvider(api_key=api_key, **kwargs))
    if provider == "ollama":
        return OllamaModel(
            model_name,
            provider=OllamaProvider(base_url=str(kwargs.get("base_url", "http://localhost:11434/v1"))),
        )
    raise LLMAPIError(f"Unsupported LLM provider: {provider}")
