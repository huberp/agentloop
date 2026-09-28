# Testing

The Python test suite uses `pytest`, `pytest-asyncio`, and `pydantic_ai.models.test.TestModel`.

```python
from pydantic_ai.models.test import TestModel
from agentloop.executor import AgentExecutor

executor = AgentExecutor(model=TestModel(call_tools=[], custom_output_text="hello"))
```

Run tests with:

```bash
uv run pytest -q
```
