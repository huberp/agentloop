# AgentLoop: TypeScript LangChain Agent with Mistral LLM

A simple, extensible agent loop using LangChain, Mistral LLM, and custom tools. Designed for quick prototyping and integration into larger projects.

## Features
- **Mistral LLM Integration**: Uses Mistral's API for natural language understanding and generation.
- **Tool Support**: Easily add custom tools (e.g., web search, calculations).
- **Memory**: Maintains conversation history for context-aware interactions.
- **TypeScript**: Written in TypeScript for type safety and modern JavaScript features.
- **No Build Step**: Run directly with `ts-node` for rapid development.

## Prerequisites
- Node.js (v20 or later)
- npm or yarn
- Mistral API key (sign up at [mistral.ai](https://mistral.ai/))

## Installation
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
User: Calculate 2+2
Agent: Result of 2+2: 4
User: exit
Agent: Goodbye!
```

## Adding Custom Tools
To add a new tool:
1. Edit `src/tools.ts` and add your tool to the `tools` array.
2. Implement the tool's logic in the `func` property.

Example:
```typescript
{
  name: "weather",
  description: "Get the current weather for a location",
  func: async (location: string) => {
    // Implement weather API logic here
    return `The weather in ${location} is sunny.`;
  },
}
```

## Testing
Run the test suite with:
```bash
npm test
```

## GitHub Actions
The repository includes a GitHub Actions workflow that runs tests on every push and pull request. Ensure you add your Mistral API key as a GitHub Secret named `MISTRAL_API_KEY`.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## Acknowledgments
- [LangChain](https://langchain.com/) for the agent framework.
- [Mistral AI](https://mistral.ai/) for the language model.
