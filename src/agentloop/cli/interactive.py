from __future__ import annotations

from agentloop.config import Settings
from agentloop.executor import AgentExecutor


async def run_interactive(settings: Settings | None = None) -> None:
    executor = AgentExecutor(settings=settings)
    await executor.initialize()
    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in {"exit", "quit"}:
            break
        if executor.settings.streaming_enabled:
            async for token in executor.stream(user_input):
                print(token, end="", flush=True)
            print()
        else:
            print(f"Agent: {await executor.invoke(user_input)}")
