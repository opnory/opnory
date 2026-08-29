function test() {
  // FAIL: LLM output directly sets authoritative allow/deny
  const llmResult = getLLMDecision();
  if (llmResult === "allow") {
    return { decision: "allow", reason: "LLM said so" };
  }
}