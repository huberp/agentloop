# AgentLoop

A **TypeScript LangChain Agent Loop** using the Mistral LLM API, designed for interactive conversations with tool support. This project is built for direct execution with `ts-node`, so no explicit build step is required.

## Features
- **Mistral LLM Integration**: Uses the Mistral API for natural language understanding and generation.
- **Tool Support**: Extensible with custom tools (e.g., web search, calculations).
- **Memory**: Maintains conversation history for context-aware interactions.
- **Direct TypeScript Execution**: Runs with `ts-node`—no compilation needed.

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

3. Create a `.env` file in the project root and add your Mistral API key:
   ```env
   MISTRAL_API_KEY=your_mistral_api_key_here
   ```

## Usage
Run the agent directly with `ts-node`:
```bash
npx ts-node src/index.ts
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