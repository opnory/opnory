function test() {
  // FAIL: ad-hoc success object literal with status succeeded and mutated
  return { status: "succeeded", mutated: true, provider: "entra" };
}