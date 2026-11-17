import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import { createRequire } from 'node:module';
import { parse } from 'yaml';

interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown> };
}

// Reads an OpenAPI contract of the docs repo and checks real responses against it.
export function loadContract(path: string) {
  const available = existsSync(path);
  const contract = (available ? parse(readFileSync(path, 'utf8')) : { paths: {}, components: {} }) as Contract;
  const ajv = new Ajv({ strict: false, allErrors: true });
  // ajv-formats ships CommonJS without a usable default export under NodeNext.
  createRequire(import.meta.url)('ajv-formats')(ajv);

  return {
    available,
    paths: contract.paths,
    assertMatchesSchema(schemaName: string, body: unknown) {
      const validate = ajv.compile({
        $ref: `#/components/schemas/${schemaName}`,
        components: contract.components,
      });
      if (!validate(body)) {
        throw new Error(
          `${schemaName} does not match the contract: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`,
        );
      }
    },
    // The status code must be one the contract lists for that operation.
    assertDocumented(method: string, path: string, status: number) {
      const responses = contract.paths[path]?.[method.toLowerCase()]?.responses;
      if (!responses) throw new Error(`${method} ${path} is not in the contract`);
      if (!(String(status) in responses)) {
        throw new Error(`${method} ${path} answered ${status}, contract lists ${Object.keys(responses).join(', ')}`);
      }
    },
  };
}

// The contracts live in the docs repo.
export const specPath = (file: string) => resolve(process.env.SPECS_DIR ?? '../Claude/specs', file);

const auth = loadContract(
  resolve(process.env.AUTH_CONTRACT_PATH ?? specPath('001-auth-roles/contracts/auth-api.yaml')),
);
export const CONTRACT_PATH = specPath('001-auth-roles/contracts/auth-api.yaml');
export const contractAvailable = auth.available;
export const assertMatchesSchema = (schemaName: string, body: unknown) => auth.assertMatchesSchema(schemaName, body);
export const assertDocumented = (method: string, path: string, status: number) =>
  auth.assertDocumented(method, path, status);
