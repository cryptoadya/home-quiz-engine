export const ROUND_DESCRIPTION_MAX_LENGTH = 5000;

export function roundDescriptionTooLong(value: string): boolean {
  return value.length > ROUND_DESCRIPTION_MAX_LENGTH;
}
