# Usage

## One-shot agent run

```bash
agentloop agent -u "Summarize src/agentloop"
```

## Streaming

```bash
agentloop agent --stream -u "Walk me through the latest changes"
```

## Programmatic orchestration

```python
from agentloop.orchestrator import execute_plan, make_plan
```
