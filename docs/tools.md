# Tools

Tools live in `src/agentloop/tools/` and use the `@tool_def` decorator.

```python
from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools.registry import tool_def

class MyToolInput(BaseModel):
    message: str

@tool_def(name="my_tool", description="Echo a message", permissions="safe")
async def my_tool(ctx: RunContext[AgentDeps], args: MyToolInput) -> str:
    return f"Echo: {args.message}"
```

`ToolRegistry.to_pydantic_ai_tools()` converts decorated functions into PydanticAI `Tool` objects and attaches policy metadata.
