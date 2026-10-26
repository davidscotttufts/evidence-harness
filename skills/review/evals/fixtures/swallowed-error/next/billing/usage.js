export async function usageFromModel(callModel, account) {
  const text = await callModel(`Summarise usage for ${account}`);
  try {
    return JSON.parse(text);
  } catch {
    return { units: 0 };
  }
}
