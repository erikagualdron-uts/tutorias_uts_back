import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import { createRequire } from 'node:module';
import { parse } from 'yaml';

// The contract lives in the docs repo (specs/001-auth-roles/contracts/auth-api.yaml).
export const CONTRACT_PATH = resolve(
  process.env.AUTH_CONTRACT_PATH ??
    '../Claude/specs/001-auth-roles/contracts/auth-api.yaml',
);
export const contractAvailable = existsSync(CONTRACT_PATH);

interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown> };
}

const contract = (
  contractAvailable ? parse(readFileSync(CONTRACT_PATH, 'utf8')) : {}
) as Contract;
const ajv = new Ajv({ strict: false, allErrors: true });
// ajv-formats ships CommonJS without a usable default export under NodeNext.
createRequire(import.meta.url)('ajv-formats')(ajv);

export function assertMatchesSchema(schemaName: string, body: unknown) {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${schemaName}`,
    components: contract.components,
  });
  if (!validate(body)) {
    throw new Error(
      `${schemaName} does not match the contract: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`,
    );
  }
}

// The status code must be one the contract lists for that operation.
export function assertDocumented(method: string, path: string, status: number) {
  const responses = contract.paths[path]?.[method.toLowerCase()]?.responses;
  if (!responses) throw new Error(`${method} ${path} is not in the contract`);
  if (!(String(status) in responses)) {
    throw new Error(
      `${method} ${path} answered ${status}, contract lists ${Object.keys(responses).join(', ')}`,
    );
  }
}
