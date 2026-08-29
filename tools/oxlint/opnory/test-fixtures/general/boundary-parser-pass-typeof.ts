// PASS: boundary typeof check for JSON parse
function parseJson(input: unknown) {
  const parsed = JSON.parse(input as string);
  if (typeof parsed === "object" && parsed !== null) {
    return parsed;
  }
  throw new Error("Invalid JSON");
}