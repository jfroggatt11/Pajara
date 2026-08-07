export function localDatetimeValue(date = new Date()): string {
  const localMilliseconds = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localMilliseconds).toISOString().slice(0, 16);
}

export function localDatetimeToIso(value: string): string {
  if (!value) throw new Error("Choose when this happened.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Choose a valid date and time.");
  return parsed.toISOString();
}
