import type { output, ZodError, ZodType } from 'zod';

export type EnvironmentInput = Readonly<Record<string, string | undefined>>;

export class EnvironmentValidationError extends Error {
  readonly application: string;
  readonly variables: readonly string[];

  constructor(application: string, error: ZodError) {
    const details = error.issues.map((issue) => {
      const variable = issue.path.length > 0 ? issue.path.map(String).join('.') : 'environment';

      return `${variable}: ${issue.message}`;
    });

    super(`Invalid ${application} environment:\n- ${details.join('\n- ')}`);
    this.name = 'EnvironmentValidationError';
    this.application = application;
    this.variables = [...new Set(error.issues.flatMap((issue) => issue.path.map(String)))];
  }
}

export function parseEnvironment<TSchema extends ZodType>(
  application: string,
  schema: TSchema,
  environment: EnvironmentInput,
): output<TSchema> {
  const result = schema.safeParse(environment);

  if (!result.success) {
    throw new EnvironmentValidationError(application, result.error);
  }

  return result.data;
}
