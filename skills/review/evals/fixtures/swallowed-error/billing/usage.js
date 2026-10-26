export async function usageFromModel(callModel, account) {
  const text = await callModel(`Summarise usage for ${account}`);
  return JSON.parse(text);
}
