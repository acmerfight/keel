export function normalizeName(value) {
  return value;
}

export function nameKey(value) {
  const checksum = [...value].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return { normalized: value, checksum };
}

export function formatRecord(value) {
  return value;
}
