import { agentExecutor } from "../index";

describe("Agent Loop", () => {
  it("should initialize and respond to a simple query", async () => {
    const result = await agentExecutor.invoke({
      input: "Hello, how are you?",
    });
    expect(result.output).toBeDefined();
  });
});