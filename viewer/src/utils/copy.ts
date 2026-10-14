/** `1 screen`, `2 screens`: a count with the noun that agrees with it. */
export function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
