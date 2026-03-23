// Must start with "mock" for jest hoisting
const mockChatMistralAI = jest.fn().mockImplementation(() => ({
  bindTools: jest.fn().mockReturnValue({ invoke: jest.fn() }),
}));

jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: mockChatMistralAI,
}));

import { createLLM } from "../llm";

const baseConfig = {
  llmProvider: "mistral",
  llmModel: "",
  llmTemperature: 0.7,
  mistralApiKey: "test-key",
};

describe("createLLM factory", () => {
  beforeEach(() => mockChatMistralAI.mockClear());

  it("returns a ChatMistralAI instance for provider 'mistral'", () => {
    createLLM(baseConfig);
    expect(mockChatMistralAI).toHaveBeenCalledTimes(1);
    expect(mockChatMistralAI).toHaveBeenCalledWith({
      apiKey: "test-key",
      model: undefined,
      temperature: 0.7,
    });
  });

  it("passes llmModel to ChatMistralAI when explicitly set", () => {
    createLLM({ ...baseConfig, llmModel: "mistral-large-latest" });
    expect(mockChatMistralAI).toHaveBeenCalledWith(
      expect.objectContaining({ model: "mistral-large-latest" })
    );
  });

  it("passes custom temperature to ChatMistralAI", () => {
    createLLM({ ...baseConfig, llmTemperature: 0.2 });
    expect(mockChatMistralAI).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.2 })
    );
  });

  it("is case-insensitive for provider name ('Mistral')", () => {
    createLLM({ ...baseConfig, llmProvider: "Mistral" });
    expect(mockChatMistralAI).toHaveBeenCalledTimes(1);
  });

  it("throws a descriptive error for an unknown provider", () => {
    expect(() => createLLM({ ...baseConfig, llmProvider: "unknown" })).toThrow(
      /Unknown LLM provider.*"unknown"/
    );
  });
});
