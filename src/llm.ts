import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatMistralAI } from "@langchain/mistralai";

/** Config fields consumed by the LLM factory. */
export interface LLMConfig {
  llmProvider: string;
  llmModel: string;
  llmTemperature: number;
  mistralApiKey: string;
}

/**
 * Factory that instantiates the configured LangChain chat model.
 * Add new providers to the switch block to extend support.
 *
 * @throws {Error} if the provider is not supported or does not implement tool binding.
 */
export function createLLM(config: LLMConfig): BaseChatModel {
  let model: BaseChatModel;

  switch (config.llmProvider.toLowerCase()) {
    case "mistral":
      model = new ChatMistralAI({
        apiKey: config.mistralApiKey,
        // Pass model name only when explicitly set; let the SDK use its default otherwise
        model: config.llmModel !== "" ? config.llmModel : undefined,
        temperature: config.llmTemperature,
      });
      break;

    // Extension point: add "openai", "anthropic", "ollama", etc. here

    default:
      throw new Error(
        `Unknown LLM provider: "${config.llmProvider}". Supported providers: mistral`
      );
  }

  // Validate tool-binding support early, before the model reaches the agent loop
  if (!model.bindTools) {
    throw new Error(
      `LLM provider "${config.llmProvider}" does not support tool binding`
    );
  }

  return model;
}
