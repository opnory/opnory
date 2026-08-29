// PASS: boundary parser - schema validation at boundary
function parseWebhook(input: unknown) {
  return WebhookSchema.parse(input);
}