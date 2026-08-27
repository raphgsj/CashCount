export function maskSensitiveDigitSequences(value: string): string {
  return value.replace(/(?<!\d)\d(?:[\s.-]?\d){4,18}(?!\d)/gu, (candidate) => {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return candidate;
    const digits = candidate.replaceAll(/\D/gu, '');
    return `••••${digits.slice(-4)}`;
  });
}
