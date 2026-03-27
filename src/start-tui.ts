process.env.UI_MODE = "tui";

export {};

async function bootstrap(): Promise<void> {
  const { main } = await import("./index");
  await main();
}

bootstrap().catch(console.error);