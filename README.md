# AgentLoop

A **TypeScript LangChain Agent Loop** using the Mistral LLM API, designed for interactive conversations with tool support. This project is built for direct execution with `tsx`, so no explicit build step is required.

## Features
- **Mistral LLM Integration**: Uses the Mistral API for natural language understanding and generation.
- **Tool Support**: Extensible tools with native `bindTools` flow and tool-result round trips.
- **Memory**: Maintains conversation history for context-aware interactions.
- **Structured Logging**: Uses Pino and logs tool calls, arguments, and tool responses.
- **Direct TypeScript Execution**: Runs with `tsx`—no compilation needed.

## Prerequisites
- Node.js (v20 or later)
- npm or yarn
- Mistral API key (sign up at [mistral.ai](https://mistral.ai/))

## Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/huberp/agentloop.git
   cd agentloop
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the project root and add runtime configuration:
   ```env
   MISTRAL_API_KEY=your_mistral_api_key_here
   LOG_LEVEL=info
   LOG_ENABLED=true
   LOG_DESTINATION=stdout
   LOG_NAME=agentloop
   LOG_TIMESTAMP=true
   LLM_PROVIDER=mistral
   LLM_MODEL=
   LLM_TEMPERATURE=0.7
   ```

## Usage
Run the agent directly with `tsx`:
```bash
npx tsx src/index.ts
```

### Example Interaction
```plaintext
User: What is the capital of France?
Agent: The capital of France is Paris.

User: Calculate 5 * 8
Agent: Result of 5 * 8: 40

User: exit
Agent: Goodbye!
```

## Tools
The agent supports the following tools by default:
- **Search**: Mock web search (replace with a real API like SerpAPI or Google Custom Search).
- **Calculate**: Evaluates mathematical expressions.

To add more tools, edit `src/tools.ts` and register them in `src/index.ts`.

## Logging
- Logging is configured via dotenv-backed config in `src/config.ts`.
- Logger implementation is in `src/logger.ts` and writes to stdout by default.
- Each model turn logs:
   - requested tool count and names
   - each tool invocation with arguments
   - each tool result payload

You can change logging behavior with environment variables:
- `LOG_LEVEL` (for example: `debug`, `info`, `warn`, `error`)
- `LOG_ENABLED` (`true` or `false`)
- `LOG_DESTINATION` (`stdout` or `stderr`)
- `LOG_NAME` (logger name field)
- `LOG_TIMESTAMP` (`true` or `false`)

## Streaming

Set `STREAMING_ENABLED=true` to enable streaming mode.  In this mode the CLI
prints each token as it arrives from the LLM instead of waiting for the full
response before printing.

Tool calls are automatically handled during streaming: partial `ToolCallChunk`
messages are buffered per-index until each call is fully assembled, the tool is
executed, and streaming resumes for the next LLM turn.

The programmatic API exposes both modes:

```ts
// Non-streaming (default) – returns the full output once complete
const { output } = await agentExecutor.invoke("What is 2+2?");

// Streaming – yields text chunks incrementally via an AsyncGenerator
for await (const chunk of agentExecutor.stream("What is 2+2?")) {
  process.stdout.write(chunk);
}
```

The streaming loop lives in `src/streaming.ts` and is wired into `src/index.ts`
via an `executeWithToolsStream` wrapper.

## LLM Provider

The LLM is configured via `src/llm.ts`, which exports a `createLLM(config)` factory used by `src/index.ts`.

- `LLM_PROVIDER` — selects the chat model provider (default: `mistral`; add new providers to the switch in `src/llm.ts`)
- `LLM_MODEL` — optional model name passed to the provider SDK (uses SDK default when empty)
- `LLM_TEMPERATURE` — sampling temperature (default: `0.7`)

## Architecture Notes
- `src/config.ts` is the single place that initializes dotenv and reads runtime configuration.
- `src/llm.ts` exports `createLLM(config)`, a provider factory that returns a `BaseChatModel`. Extend the switch block to add new providers.
- `src/index.ts` uses `createLLM(appConfig)` to obtain the LLM and binds tools with `llm.bindTools(tools)`.
- Backward compatibility fallback for non-`bindTools` runtimes has been removed after library upgrades.

## Testing
Run tests with:
```bash
npm test
```

## GitHub Actions
The repository includes a workflow (`.github/workflows/test.yml`) that runs tests on every push/pull request. Ensure you add your Mistral API key as a GitHub Secret named `MISTRAL_API_KEY`.

## License
This project is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

## Contributing
Contributions are welcome! Open an issue or submit a pull request.

## Acknowledgements
- [LangChain](https://langchain.com/) for the agent framework.
- [Mistral AI](https://mistral.ai/) for the LLM API.