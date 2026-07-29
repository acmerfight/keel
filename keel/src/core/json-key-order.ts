function firstCodePoint(character: string): number {
  const codePoint = character.codePointAt(0);
  /* v8 ignore next 3 -- Array.from(string) never passes an empty string. */
  if (codePoint === undefined) {
    throw new Error("missing JSON object key code point");
  }
  return codePoint;
}

export function compareJsonObjectKeys(left: string, right: string): number {
  const leftCodePoints = Array.from(left, firstCodePoint);
  const rightCodePoints = Array.from(right, firstCodePoint);
  for (const [index, leftCodePoint] of leftCodePoints.entries()) {
    const rightCodePoint = rightCodePoints[index];
    if (rightCodePoint === undefined) return 1;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint;
    }
  }
  return leftCodePoints.length === rightCodePoints.length ? 0 : -1;
}
